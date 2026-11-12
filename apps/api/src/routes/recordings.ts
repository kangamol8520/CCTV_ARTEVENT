/**
 * Central recordings (Phase 2): status, per-camera recording switch, segment search, file
 * streaming and clip export. Files are written by the separate recorder process (src/recorder.ts).
 */
import { Elysia, t } from "elysia";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { badRequest, notFound, HttpError } from "../lib/errors.ts";
import { env } from "../lib/env.ts";
import { diskUsage, mediaUrl, RECORDER_STATUS_KEY, verifyMedia, type RecorderStatus } from "../services/recordings.ts";

const MAX_EXPORT_MS = 2 * 60 * 60 * 1000;

function parseRange(from: string, to: string) {
  const f = new Date(from);
  const tt = new Date(to);
  if (isNaN(f.getTime()) || isNaN(tt.getTime()) || tt <= f) throw badRequest("Invalid time range");
  return { from: f, to: tt };
}

/** File streaming, authorized by a signed URL (a <video> element cannot send a bearer header). */
export const recordingMediaRoutes = new Elysia({ prefix: "/recordings" }).get(
  "/media/:id",
  async ({ params, query, request, set }) => {
    const id = Number(params.id);
    if (!verifyMedia(id, Number(query.exp), query.sig)) throw new HttpError(403, "Invalid or expired media link");
    const rec = await prisma.recording.findUnique({ where: { id }, select: { filePath: true } });
    if (!rec) throw notFound("Recording");
    const file = Bun.file(join(env.recordingsDir, rec.filePath));
    if (!(await file.exists())) throw notFound("Recording file");
    const size = file.size;
    const headers: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
    if (!m) return new Response(file, { headers: { ...headers, "Content-Length": String(size) } });
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      set.status = 416;
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  },
  { query: t.Object({ exp: t.String(), sig: t.String() }) },
);

export const recordingRoutes = new Elysia({ prefix: "/recordings" })
  .use(authGuard)
  .get("/status", async () => {
    const setting = await prisma.setting.findUnique({ where: { key: RECORDER_STATUS_KEY } });
    const recorder = setting ? (JSON.parse(setting.value) as RecorderStatus) : null;
    const alive = !!recorder && Date.now() - new Date(recorder.updatedAt).getTime() < 60_000;
    const cams = await prisma.camera.findMany({
      where: { OR: [{ recordEnabled: true }, { recordings: { some: {} } }] },
      select: { id: true, deviceNo: true, name: true, status: true, recordEnabled: true, recordStream: true, fisheye: true },
      orderBy: { deviceNo: "asc" },
    });
    const stats = await prisma.recording.groupBy({
      by: ["cameraId"],
      _count: { _all: true },
      _sum: { sizeBytes: true, durationMs: true },
      _min: { startedAt: true },
      _max: { endedAt: true },
    });
    const byCam = new Map(stats.map((s) => [s.cameraId, s]));
    return {
      recorder: recorder ? { ...recorder, alive } : null,
      config: { segmentSeconds: env.recordingSegmentSeconds, retentionDays: env.recordingRetentionDays, minFreeGb: env.recordingMinFreeGb },
      disk: await diskUsage(env.recordingsDir).catch(() => null),
      cameras: cams.map((c) => {
        const s = byCam.get(c.id);
        const job = recorder?.cameras.find((j) => j.cameraId === c.id) ?? null;
        return {
          ...c,
          job: job && alive ? job : null,
          files: s?._count._all ?? 0,
          bytes: Number(s?._sum.sizeBytes ?? 0),
          recordedMs: s?._sum.durationMs ?? 0,
          oldest: s?._min.startedAt ?? null,
          newest: s?._max.endedAt ?? null,
        };
      }),
    };
  })
  .patch(
    "/cameras/:id",
    async ({ params, body, user }) => {
      requireRole(user, "ADMIN");
      const cam = await prisma.camera.update({
        where: { id: Number(params.id) },
        data: { recordEnabled: body.recordEnabled, ...(body.recordStream ? { recordStream: body.recordStream } : {}) },
        select: { id: true, deviceNo: true, recordEnabled: true, recordStream: true },
      });
      await audit(user.id, "RECORDING_SET", "Camera", cam.id, cam);
      return cam;
    },
    { body: t.Object({ recordEnabled: t.Boolean(), recordStream: t.Optional(t.Union([t.Literal("MAIN"), t.Literal("SUB")])) }) },
  )
  .get(
    "/:cameraId/segments",
    async ({ params, query }) => {
      const cameraId = Number(params.cameraId);
      const { from, to } = parseRange(query.from, query.to);
      const rows = await prisma.recording.findMany({
        where: { cameraId, startedAt: { lt: to }, endedAt: { gt: from } },
        orderBy: { startedAt: "asc" },
        select: { id: true, startedAt: true, endedAt: true, durationMs: true, sizeBytes: true, videoCodec: true, width: true, height: true, hasAudio: true },
      });
      return rows.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes), url: mediaUrl(r.id) }));
    },
    { query: t.Object({ from: t.String(), to: t.String() }) },
  )
  .get(
    "/:cameraId/export",
    async ({ params, query, user }) => {
      const cameraId = Number(params.cameraId);
      const { from, to } = parseRange(query.from, query.to);
      if (to.getTime() - from.getTime() > MAX_EXPORT_MS) throw badRequest("Export is limited to 2 hours");
      const cam = await prisma.camera.findUnique({ where: { id: cameraId }, select: { deviceNo: true } });
      if (!cam) throw notFound("Camera");
      const rows = await prisma.recording.findMany({
        where: { cameraId, startedAt: { lt: to }, endedAt: { gt: from } },
        orderBy: { startedAt: "asc" },
        select: { filePath: true, startedAt: true, videoCodec: true },
      });
      if (!rows.length) throw notFound("Recordings in this range");

      const dir = await mkdtemp(join(tmpdir(), "cctv-export-"));
      try {
        const list = join(dir, "list.txt");
        await writeFile(list, rows.map((r) => `file '${join(env.recordingsDir, r.filePath).replaceAll("'", "'\\''")}'`).join("\n"));
        const offset = Math.max(0, (from.getTime() - rows[0]!.startedAt.getTime()) / 1000);
        const length = (to.getTime() - Math.max(from.getTime(), rows[0]!.startedAt.getTime())) / 1000;
        const out = join(dir, "clip.mp4");
        const p = Bun.spawn(
          ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
            "-ss", offset.toFixed(2), "-t", length.toFixed(2), "-map", "0", "-c", "copy",
            ...(rows[0]!.videoCodec === "hevc" ? ["-tag:v", "hvc1"] : []), "-movflags", "+faststart", out],
          { stdout: "ignore", stderr: "pipe" },
        );
        const err = await new Response(p.stderr).text();
        if ((await p.exited) !== 0) throw new Error(`export failed: ${err.slice(0, 300)}`);
        const data = await Bun.file(out).arrayBuffer();
        await audit(user.id, "RECORDING_EXPORT", "Camera", cameraId, { from, to });
        const stamp = from.toISOString().replace(/[-:]/g, "").slice(0, 15);
        return new Response(data, {
          headers: { "Content-Type": "video/mp4", "Content-Disposition": `attachment; filename="${cam.deviceNo}_${stamp}.mp4"` },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { query: t.Object({ from: t.String(), to: t.String() }) },
  );
