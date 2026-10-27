/**
 * Unified playback across NVRs. The caller only knows the camera; the API finds the right NVR,
 * searches its recordings, and exposes a time-boxed go2rtc stream that the same player can play.
 */
import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard } from "../lib/auth.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { env } from "../lib/env.ts";
import { searchRecordings } from "../services/hikvision.ts";
import { buildPlaybackSource } from "../services/streams.ts";
import { putStream, deleteStream } from "../services/go2rtc.ts";

const PLAYBACK_TTL_MS = 2 * 60 * 60 * 1000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const playbackRoutes = new Elysia({ prefix: "/playback" })
  .use(authGuard)
  .get(
    "/:cameraId/segments",
    async ({ params, query }) => {
      const cam = await prisma.camera.findUnique({ where: { id: Number(params.cameraId) }, include: { nvr: true } });
      if (!cam) throw notFound("Camera");
      if (!cam.nvr || !cam.nvrChannel) throw badRequest("Camera is not mapped to an NVR channel");
      if (cam.nvr.brand !== "HIKVISION") throw badRequest(`Recording search not implemented for brand ${cam.nvr.brand}`);
      const from = new Date(query.from);
      const to = new Date(query.to);
      if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) throw badRequest("Invalid time range");
      const segments = await searchRecordings(cam.nvr, cam.nvrChannel, from, to);
      return { camera: { id: cam.id, deviceNo: cam.deviceNo, name: cam.name }, nvr: { id: cam.nvr.id, name: cam.nvr.name }, channel: cam.nvrChannel, from, to, segments };
    },
    { query: t.Object({ from: t.String(), to: t.String() }) },
  )
  .post(
    "/:cameraId/stream",
    async ({ params, body, user }) => {
      const cam = await prisma.camera.findUnique({ where: { id: Number(params.cameraId) }, include: { nvr: true } });
      if (!cam) throw notFound("Camera");
      const from = new Date(body.from);
      const to = new Date(body.to);
      if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) throw badRequest("Invalid time range");
      const src = await buildPlaybackSource(cam, from, to);
      if (!src) throw badRequest("Camera is not mapped to an NVR channel");
      const name = `pb-${cam.id}-${user.id}-${from.getTime()}`;
      await putStream(name, src);
      const old = timers.get(name);
      if (old) clearTimeout(old);
      timers.set(name, setTimeout(() => { deleteStream(name).catch(() => {}); timers.delete(name); }, PLAYBACK_TTL_MS));
      return { stream: name, go2rtcUrl: env.go2rtcPublicUrl, from, to };
    },
    { body: t.Object({ from: t.String(), to: t.String() }) },
  )
  .delete("/stream/:name", async ({ params }) => {
    if (!params.name.startsWith("pb-")) throw badRequest("Not a playback stream");
    await deleteStream(params.name).catch(() => {});
    const tmr = timers.get(params.name);
    if (tmr) clearTimeout(tmr);
    timers.delete(params.name);
    return { ok: true };
  });
