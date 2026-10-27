import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";
import { encryptSecret } from "../lib/crypto.ts";
import { audit } from "../lib/audit.ts";
import { notFound } from "../lib/errors.ts";
import { env } from "../lib/env.ts";
import { streamName } from "../services/streams.ts";
import { syncCamera } from "../services/go2rtc.ts";
import { tcpProbe } from "../services/health.ts";

const cameraSelect = {
  id: true, deviceNo: true, name: true, description: true, brand: true, model: true, protocol: true, host: true, rtspPort: true, httpPort: true,
  username: true, mainStreamPath: true, subStreamPath: true, nvrId: true, nvrChannel: true, floorId: true, roomId: true, isEnabled: true,
  status: true, lastSeenAt: true, sortOrder: true, legacyId: true, legacyNvrRef: true, importFlags: true, purchaseDate: true, warrantyEnd: true,
  createdAt: true, updatedAt: true,
  floor: { select: { id: true, code: true, name: true } },
  room: { select: { id: true, code: true, name: true } },
  nvr: { select: { id: true, name: true, host: true } },
} as const;

/** Adds the go2rtc stream names + public URL so the frontend can build a player without knowing credentials. */
function withStreams<T extends { id: number }>(cam: T) {
  return { ...cam, streams: { main: streamName(cam.id), sub: streamName(cam.id, true), go2rtcUrl: env.go2rtcPublicUrl } };
}

const cameraBody = t.Object({
  deviceNo: t.String({ minLength: 1 }),
  name: t.String({ minLength: 1 }),
  description: t.Optional(t.Nullable(t.String())),
  brand: t.Optional(t.String()),
  model: t.Optional(t.Nullable(t.String())),
  protocol: t.Optional(t.Union([t.Literal("HIKVISION"), t.Literal("ONVIF"), t.Literal("RTSP"), t.Literal("NVR_CHANNEL")])),
  host: t.Optional(t.Nullable(t.String())),
  rtspPort: t.Optional(t.Integer()),
  httpPort: t.Optional(t.Integer()),
  username: t.Optional(t.Nullable(t.String())),
  password: t.Optional(t.Nullable(t.String())),
  mainStreamPath: t.Optional(t.Nullable(t.String())),
  subStreamPath: t.Optional(t.Nullable(t.String())),
  nvrId: t.Optional(t.Nullable(t.Integer())),
  nvrChannel: t.Optional(t.Nullable(t.Integer())),
  floorId: t.Optional(t.Nullable(t.Integer())),
  roomId: t.Optional(t.Nullable(t.Integer())),
  isEnabled: t.Optional(t.Boolean()),
  sortOrder: t.Optional(t.Integer()),
  importFlags: t.Optional(t.Nullable(t.String())),
});

export const cameraRoutes = new Elysia({ prefix: "/cameras" })
  .use(authGuard)
  .get(
    "/",
    async ({ query }) => {
      const where: Record<string, unknown> = {};
      if (query.floorId) where.floorId = Number(query.floorId);
      if (query.roomId) where.roomId = Number(query.roomId);
      if (query.nvrId) where.nvrId = Number(query.nvrId);
      if (query.status) where.status = query.status;
      if (query.enabled !== undefined) where.isEnabled = query.enabled === "true";
      if (query.q) where.OR = [{ deviceNo: { contains: query.q } }, { name: { contains: query.q } }, { description: { contains: query.q } }, { host: { contains: query.q } }];
      const cams = await prisma.camera.findMany({ where, select: cameraSelect, orderBy: [{ floorId: "asc" }, { roomId: "asc" }, { sortOrder: "asc" }, { deviceNo: "asc" }] });
      return cams.map(withStreams);
    },
    { query: t.Object({ floorId: t.Optional(t.String()), roomId: t.Optional(t.String()), nvrId: t.Optional(t.String()), status: t.Optional(t.String()), enabled: t.Optional(t.String()), q: t.Optional(t.String()) }) },
  )
  .get("/:id", async ({ params }) => {
    const cam = await prisma.camera.findUnique({ where: { id: Number(params.id) }, select: cameraSelect });
    if (!cam) throw notFound("Camera");
    return withStreams(cam);
  })
  .post(
    "/",
    async ({ user, body }) => {
      requireRole(user, "ADMIN");
      const { password, ...rest } = body;
      const created = await prisma.camera.create({ data: { ...rest, passwordEnc: password ? await encryptSecret(password) : null }, select: cameraSelect });
      await audit(user.id, "CREATE", "Camera", created.id, { deviceNo: body.deviceNo });
      syncCamera(created.id).catch((e) => console.error("[go2rtc]", e.message));
      return withStreams(created);
    },
    { body: cameraBody },
  )
  .patch(
    "/:id",
    async ({ user, params, body }) => {
      requireRole(user, "OPERATOR");
      const { password, ...rest } = body;
      const data: Record<string, unknown> = { ...rest };
      if (password) data.passwordEnc = await encryptSecret(password);
      const updated = await prisma.camera.update({ where: { id: Number(params.id) }, data, select: cameraSelect });
      await audit(user.id, "UPDATE", "Camera", updated.id, rest);
      syncCamera(updated.id).catch((e) => console.error("[go2rtc]", e.message));
      return withStreams(updated);
    },
    { body: t.Partial(cameraBody) },
  )
  .delete("/:id", async ({ user, params }) => {
    requireRole(user, "ADMIN");
    const id = Number(params.id);
    await prisma.camera.update({ where: { id }, data: { isEnabled: false } });
    await syncCamera(id).catch(() => {});
    await prisma.camera.delete({ where: { id } });
    await audit(user.id, "DELETE", "Camera", id);
    return { ok: true };
  })
  .post("/:id/probe", async ({ params }) => {
    const cam = await prisma.camera.findUnique({ where: { id: Number(params.id) }, include: { nvr: true } });
    if (!cam) throw notFound("Camera");
    const host = cam.protocol === "NVR_CHANNEL" ? cam.nvr?.host : cam.host;
    const port = cam.protocol === "NVR_CHANNEL" ? cam.nvr?.rtspPort : cam.rtspPort;
    const ok = host && port ? await tcpProbe(host, port) : false;
    await prisma.camera.update({ where: { id: cam.id }, data: { status: ok ? "ONLINE" : "OFFLINE", ...(ok ? { lastSeenAt: new Date() } : {}) } });
    return { ok, host, port };
  })
  .post("/:id/sync-stream", async ({ user, params }) => {
    requireRole(user, "OPERATOR");
    return syncCamera(Number(params.id));
  });
