/**
 * Face entry/exit log (Phase 3).
 *   /face/media/*   signed image URLs (event snapshot, employee photo) — no bearer needed
 *   /face/worker/*  used by apps/face/worker.py, authorized by X-Worker-Token
 *   /face/*         UI: status, per-camera settings, zone frame, event list, corrections
 */
import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { badRequest, notFound, HttpError } from "../lib/errors.ts";
import { env } from "../lib/env.ts";
import { decryptSecret } from "../lib/crypto.ts";
import { employees, FACE_STATUS_KEY, faceMediaUrl, safeJoin, verifyFaceMedia, verifyWorker, type FaceWorkerStatus } from "../services/face.ts";

/** A matched person seen again on the same camera within this window extends the same event. */
const MERGE_MS = 60_000;
/** "Walking away" thresholds: moved up by more than this fraction of the zone height, or the face
 *  shrank below this ratio. Env-tunable while the rule is being validated. */
const AWAY_TRAVEL = Number(process.env.FACE_AWAY_TRAVEL ?? 0.05);
const AWAY_SHRINK = Number(process.env.FACE_AWAY_SHRINK ?? 0.75);
const ZONE_RE = /^(0(\.\d+)?|1(\.0+)?),(0(\.\d+)?|1(\.0+)?),(0(\.\d+)?|1(\.0+)?),(0(\.\d+)?|1(\.0+)?)$/;

export const faceMediaRoutes = new Elysia({ prefix: "/face/media" }).get(
  "/:kind/:id",
  async ({ params, query }) => {
    const { kind, id } = params;
    if ((kind !== "snap" && kind !== "emp") || !verifyFaceMedia(kind, id, Number(query.exp), query.sig)) {
      throw new HttpError(403, "Invalid or expired media link");
    }
    let path: string | null = null;
    if (kind === "snap") {
      const ev = await prisma.accessEvent.findUnique({ where: { id: Number(id) }, select: { snapshotPath: true } });
      path = ev?.snapshotPath ? safeJoin(env.faceDataDir, ev.snapshotPath) : null;
    } else {
      const emp = (await employees()).get(id);
      path = emp?.photo ? safeJoin(`${env.employeesDir}/photos`, emp.photo) : null;
    }
    const file = path ? Bun.file(path) : null;
    if (!file || !(await file.exists())) throw notFound("Image");
    return new Response(file, { headers: { "Content-Type": file.type || "image/jpeg", "Cache-Control": "private, max-age=3600" } });
  },
  { query: t.Object({ exp: t.String(), sig: t.String() }) },
);

const workerGuard = new Elysia({ name: "face-worker-guard" }).onBeforeHandle({ as: "scoped" }, ({ request }) => {
  if (!verifyWorker(request.headers.get("x-worker-token"))) throw new HttpError(401, "Invalid worker token");
});

export const faceWorkerRoutes = new Elysia({ prefix: "/face/worker" })
  .use(workerGuard)
  /** Human-confirmed events (reviewed + MATCHED) the worker learns extra templates from, so faces
   *  as this camera sees them (angle, light) are recognised better next time. Newest first. */
  .get("/reviewed", async () => {
    const sel = { id: true, empCode: true, snapshotPath: true } as const;
    const human = await prisma.accessEvent.findMany({
      where: { reviewedAt: { not: null }, status: "MATCHED", empCode: { not: null }, snapshotPath: { not: null } },
      orderBy: { reviewedAt: "desc" }, take: 20000, select: sel,
    });
    // fingerprint-confirmed passes, stricter than the confirmation itself (a wrong template would
    // teach the wrong face): decent score and the scan within 6 min on the expected side of the pass
    const byScan = await prisma.accessEvent.findMany({
      where: {
        confirmedBy: "SCAN", reviewedAt: null, status: "MATCHED", empCode: { not: null }, snapshotPath: { not: null }, similarity: { gte: 0.42 },
        OR: [{ direction: "IN", scanGapSec: { gte: 0, lte: 360 } }, { direction: "OUT", scanGapSec: { gte: -360, lte: 0 } }],
      },
      orderBy: { firstSeenAt: "desc" }, take: 20000, select: sel,
    });
    const active = await employees();
    // human confirmations first: the worker keeps the first N per employee
    return [...human, ...byScan].filter((r) => !active.size || active.has(r.empCode!));
  })
  .get("/config", async () => {
    const cams = await prisma.camera.findMany({
      where: { faceEnabled: true, isEnabled: true },
      select: { id: true, deviceNo: true, faceDirection: true, faceZone: true, protocol: true, host: true, httpPort: true, username: true, passwordEnc: true },
    });
    return {
      rtspBase: env.go2rtcRtspUrl,
      cameras: await Promise.all(cams.map(async (c) => ({
        id: c.id,
        deviceNo: c.deviceNo,
        direction: c.faceDirection ?? "IN",
        zone: c.faceZone ? c.faceZone.split(",").map(Number) : null,
        rtsp: `${env.go2rtcRtspUrl}/cam-${c.id}`,
        // ONVIF access for the camera's own person detection (worker gate). Direct-IP cameras only;
        // this endpoint is worker-token protected and the worker runs on this server.
        onvif: c.host && c.protocol !== "NVR_CHANNEL" && c.passwordEnc
          ? { host: c.host, port: c.httpPort, username: c.username ?? "admin", password: await decryptSecret(c.passwordEnc) }
          : null,
      }))),
    };
  })
  .put(
    "/status",
    async ({ body }) => {
      const value = JSON.stringify({ ...body, updatedAt: new Date().toISOString() });
      await prisma.setting.upsert({ where: { key: FACE_STATUS_KEY }, create: { key: FACE_STATUS_KEY, value }, update: { value } });
      return { ok: true };
    },
    { body: t.Any() },
  )
  .post(
    "/events",
    async ({ body }) => {
      const first = new Date(body.firstSeenAt);
      const last = new Date(body.lastSeenAt);
      if (isNaN(first.getTime()) || isNaN(last.getTime())) throw badRequest("Invalid time");
      if (body.snapshotPath && !safeJoin(env.faceDataDir, body.snapshotPath)) throw badRequest("Invalid snapshot path");
      const cam = await prisma.camera.findUnique({ where: { id: body.cameraId }, select: { faceDirection: true } });
      if (!cam) throw notFound("Camera");
      const emp = body.empCode ? (await employees()).get(body.empCode) : undefined;
      const data = {
        status: body.status,
        empCode: body.empCode ?? null,
        empName: emp?.name ?? body.empName ?? null,
        similarity: body.similarity,
        margin: body.margin,
        candidates: JSON.stringify(body.candidates ?? []).slice(0, 2000),
        frames: body.frames,
        faceSize: body.faceSize,
        snapshotPath: body.snapshotPath ?? null,
        travelY: body.travelY ?? null,
        sizeGrowth: body.sizeGrowth ?? null,
      };
      // Direction is locked to the camera: the entrance camera (FL1-40) only gives IN times, the exit
      // camera (OD1-30) only OUT. Someone walking away from a camera (face shrinks, moves up the frame)
      // is not used at all — not flipped to the other direction: people passing back and forth would
      // otherwise become false exits, and a real entry/exit is seen face-on by the other camera.
      // CHECK = confirmation camera (FL1-11 at the stairs): its sightings only confirm an IN from the
      // entrance camera (services/in-check.ts) and never count as an entry on their own.
      const direction = cam.faceDirection === "OUT" ? "OUT" : cam.faceDirection === "CHECK" ? "CHECK" : "IN";
      const away = body.travelY != null && body.sizeGrowth != null
        && ((body.travelY < -AWAY_TRAVEL && body.sizeGrowth < 1) || body.sizeGrowth < AWAY_SHRINK);
      if (away) return { id: null, merged: false, skipped: "away", dropSnapshot: body.snapshotPath ?? null };

      // Same person lingering / re-detected after a short occlusion → extend the existing event.
      if (body.status === "MATCHED" && body.empCode) {
        const prev = await prisma.accessEvent.findFirst({
          where: { cameraId: body.cameraId, empCode: body.empCode, direction, lastSeenAt: { gte: new Date(first.getTime() - MERGE_MS) } },
          orderBy: { lastSeenAt: "desc" },
        });
        if (prev) {
          const better = body.similarity > prev.similarity;
          await prisma.accessEvent.update({
            where: { id: prev.id },
            data: {
              lastSeenAt: last > prev.lastSeenAt ? last : prev.lastSeenAt,
              frames: prev.frames + body.frames,
              ...(better ? { similarity: data.similarity, margin: data.margin, candidates: data.candidates, faceSize: data.faceSize, snapshotPath: data.snapshotPath } : {}),
            },
          });
          // The worker deletes whichever snapshot is no longer referenced.
          return { id: prev.id, merged: true, dropSnapshot: better ? prev.snapshotPath : body.snapshotPath ?? null };
        }
      }
      const ev = await prisma.accessEvent.create({
        data: { ...data, cameraId: body.cameraId, direction, firstSeenAt: first, lastSeenAt: last },
        select: { id: true },
      });
      return { id: ev.id, merged: false, dropSnapshot: null };
    },
    {
      body: t.Object({
        cameraId: t.Integer(),
        status: t.Union([t.Literal("MATCHED"), t.Literal("UNCERTAIN"), t.Literal("UNKNOWN")]),
        empCode: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
        empName: t.Optional(t.Nullable(t.String({ maxLength: 200 }))),
        similarity: t.Number(),
        margin: t.Number(),
        candidates: t.Optional(t.Array(t.Object({ code: t.String(), name: t.String(), sim: t.Number() }))),
        firstSeenAt: t.String(),
        lastSeenAt: t.String(),
        frames: t.Integer(),
        faceSize: t.Integer(),
        snapshotPath: t.Optional(t.Nullable(t.String({ maxLength: 400 }))),
        travelY: t.Optional(t.Nullable(t.Number())),
        sizeGrowth: t.Optional(t.Nullable(t.Number())),
      }),
    },
  );

export const faceRoutes = new Elysia({ prefix: "/face" })
  .use(authGuard)
  .get("/status", async () => {
    const setting = await prisma.setting.findUnique({ where: { key: FACE_STATUS_KEY } });
    const worker = setting ? (JSON.parse(setting.value) as FaceWorkerStatus) : null;
    const alive = !!worker && Date.now() - new Date(worker.updatedAt).getTime() < 60_000;
    const cams = await prisma.camera.findMany({
      where: { OR: [{ faceEnabled: true }, { faceDirection: { not: null } }] },
      select: { id: true, deviceNo: true, name: true, status: true, faceEnabled: true, faceDirection: true, faceZone: true, recordEnabled: true },
      orderBy: { deviceNo: "asc" },
    });
    return {
      worker: worker ? { ...worker, alive } : null,
      employees: (await employees()).size,
      cameras: cams.map((c) => ({ ...c, job: alive ? worker!.cameras.find((j) => j.cameraId === c.id) ?? null : null })),
    };
  })
  .patch(
    "/cameras/:id",
    async ({ params, body, user }) => {
      requireRole(user, "ADMIN");
      if (body.faceZone && !ZONE_RE.test(body.faceZone)) throw badRequest("Zone must be x0,y0,x1,y1 in 0..1");
      const cam = await prisma.camera.update({
        where: { id: Number(params.id) },
        data: {
          ...(body.faceEnabled !== undefined ? { faceEnabled: body.faceEnabled } : {}),
          ...(body.faceDirection !== undefined ? { faceDirection: body.faceDirection } : {}),
          ...(body.faceZone !== undefined ? { faceZone: body.faceZone } : {}),
        },
        select: { id: true, deviceNo: true, faceEnabled: true, faceDirection: true, faceZone: true },
      });
      await audit(user.id, "FACE_CAMERA_SET", "Camera", cam.id, cam);
      return cam;
    },
    {
      body: t.Object({
        faceEnabled: t.Optional(t.Boolean()),
        faceDirection: t.Optional(t.Nullable(t.Union([t.Literal("IN"), t.Literal("OUT"), t.Literal("CHECK")]))),
        faceZone: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
      }),
    },
  )
  /** Current frame from go2rtc, for drawing the detection zone. */
  .get("/cameras/:id/frame", async ({ params }) => {
    const res = await fetch(`${env.go2rtcUrl}/api/frame.jpeg?src=cam-${Number(params.id)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new HttpError(502, `go2rtc frame failed (${res.status})`);
    return new Response(await res.arrayBuffer(), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } });
  })
  .get(
    "/events",
    async ({ query }) => {
      const from = new Date(query.from);
      const to = new Date(query.to);
      if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) throw badRequest("Invalid time range");
      const q = query.q?.trim();
      const rows = await prisma.accessEvent.findMany({
        where: {
          firstSeenAt: { gte: from, lt: to },
          ...(query.cameraId ? { cameraId: Number(query.cameraId) } : {}),
          // confirmation-camera sightings are listed only when that camera (or CHECK) is asked for
          ...(query.direction ? { direction: query.direction } : query.cameraId ? {} : { direction: { in: ["IN", "OUT"] } }),
          ...(query.status ? { status: { in: query.status.split(",") } } : {}),
          ...(q ? { OR: [{ empCode: { contains: q } }, { empName: { contains: q } }] } : {}),
        },
        orderBy: { firstSeenAt: "desc" },
        take: Math.min(Number(query.limit ?? 2000), 5000),
        include: { camera: { select: { deviceNo: true, recordEnabled: true } } },
      });
      const emps = await employees();
      return rows.map(({ camera, candidates, ...r }) => ({
        ...r,
        deviceNo: camera.deviceNo,
        recorded: camera.recordEnabled,
        // Hide people who have left since the event was recorded (emps = current staff only).
        candidates: (candidates ? (JSON.parse(candidates) as { code: string; name: string; sim: number }[]) : []).filter((c) => !emps.size || emps.has(c.code)).map((c) => ({
          ...c,
          photoUrl: emps.get(c.code)?.photo ? faceMediaUrl("emp", c.code) : null,
        })),
        snapshotUrl: r.snapshotPath ? faceMediaUrl("snap", r.id) : null,
        photoUrl: r.empCode && emps.get(r.empCode)?.photo ? faceMediaUrl("emp", r.empCode) : null,
      }));
    },
    {
      query: t.Object({
        from: t.String(),
        to: t.String(),
        cameraId: t.Optional(t.String()),
        direction: t.Optional(t.String()),
        status: t.Optional(t.String()),
        q: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  /** Manual correction: set the right employee (or clear to UNKNOWN). */
  .patch(
    "/events/:id",
    async ({ params, body, user }) => {
      requireRole(user, "OPERATOR");
      const emp = body.empCode ? (await employees()).get(body.empCode) : undefined;
      if (body.empCode && !emp) throw badRequest("Unknown employee code");
      const ev = await prisma.accessEvent.update({
        where: { id: Number(params.id) },
        data: {
          empCode: emp?.code ?? null,
          empName: emp?.name ?? null,
          status: emp ? "MATCHED" : "UNKNOWN",
          reviewedById: user.id,
          reviewedAt: new Date(),
        },
        select: { id: true, empCode: true, empName: true, status: true },
      });
      await audit(user.id, "FACE_EVENT_CORRECT", "AccessEvent", ev.id, ev);
      return ev;
    },
    { body: t.Object({ empCode: t.Nullable(t.String()) }) },
  )
  .get(
    "/employees",
    async ({ query }) => {
      const q = (query.q ?? "").trim().toLowerCase();
      if (q.length < 2) return [];
      const out: { code: string; name: string; photoUrl: string | null }[] = [];
      for (const e of (await employees()).values()) {
        if (e.code.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)) {
          out.push({ code: e.code, name: e.name, photoUrl: e.photo ? faceMediaUrl("emp", e.code) : null });
          if (out.length >= 20) break;
        }
      }
      return out;
    },
    { query: t.Object({ q: t.Optional(t.String()) }) },
  );
