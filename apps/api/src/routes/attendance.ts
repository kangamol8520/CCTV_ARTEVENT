/**
 * Fingerprint time attendance (ZKTeco scanners) — read-only mirror of the scan logs.
 *
 * apps/attendance/pull.py reads every enabled scanner over the ZK protocol (TCP 4370) and posts new
 * scans here; the API stays the only database writer. The puller authenticates with
 * X-Worker-Token = HMAC-SHA256(APP_SECRET, "attendance-worker"), same idea as the face worker.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard } from "../lib/auth.ts";
import { badRequest, HttpError, notFound } from "../lib/errors.ts";
import { env } from "../lib/env.ts";
import { employees, faceMediaUrl } from "../services/face.ts";
import { finishRun, nextRun, publicPullState, requestPull, updatePullSettings } from "../services/attendance-pull.ts";
import { audit } from "../lib/audit.ts";

/**
 * Shift periods (Bangkok local time, minutes after midnight) used to read a day of scans:
 *   1 เข้างาน          first scan / first camera IN   in [IN.from, IN.to)
 *   2 ออกพักเบรค       first scan / first camera OUT  in the break window
 *   3 เข้างานหลังเบรค  last scan  / last camera IN    in the break window (≥ BREAK_GAP after 2)
 *   4 เลิกงาน          last scan  / last camera OUT   in [OUT.from, 24:00)  (OT included)
 * Anything else is "เข้าออกนอกเวลา". A scan within DOUBLE_MS of a chosen one is a double-scan.
 */
const PERIODS = {
  IN: { from: 5 * 60, to: 11 * 60 },
  BREAK: { from: 11 * 60, to: 14 * 60 },
  OUT: { from: 16 * 60, to: 24 * 60 },
};
const BREAK_GAP_MS = 10 * 60_000;
const DOUBLE_MS = 5 * 60_000;
const minuteOfDay = (d: Date) => { const l = new Date(d.getTime() + 7 * 3600_000); return l.getUTCHours() * 60 + l.getUTCMinutes(); };
const inWin = (d: Date, w: { from: number; to: number }) => { const m = minuteOfDay(d); return m >= w.from && m < w.to; };

const token = () => createHmac("sha256", env.appSecret).update("attendance-worker").digest("hex");
function verify(header: string | null) {
  if (!header) return false;
  const a = Buffer.from(token());
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
const guard = new Elysia({ name: "attendance-worker-guard" }).onBeforeHandle({ as: "scoped" }, ({ request }) => {
  if (!verify(request.headers.get("x-worker-token"))) throw new HttpError(401, "Invalid worker token");
});

export const attendanceWorkerRoutes = new Elysia({ prefix: "/attendance/worker" })
  .use(guard)
  /** Puller poll: read the scanners now? (manual button or the daily time) */
  .get("/next", () => nextRun())
  .post("/finished", async ({ body }) => { await finishRun(body.inserted, body.failed); return { ok: true }; },
    { body: t.Object({ inserted: t.Integer(), failed: t.Integer() }) })
  /** Enabled scanners + the newest scan already stored for each (the puller sends only newer ones). */
  .get("/devices", async () => {
    const devs = await prisma.attendanceDevice.findMany({ where: { enabled: true }, orderBy: { alias: "asc" } });
    const last = await prisma.attendancePunch.groupBy({ by: ["deviceId"], _max: { punchAt: true } });
    const lastBy = new Map(last.map((l) => [l.deviceId, l._max.punchAt]));
    return devs.map((d) => ({ id: d.id, alias: d.alias, ip: d.ip, port: d.port, lastPunchAt: lastBy.get(d.id) ?? null }));
  })
  .post(
    "/devices/:id/punches",
    async ({ params, body }) => {
      const deviceId = Number(params.id);
      const dev = await prisma.attendanceDevice.findUnique({ where: { id: deviceId } });
      if (!dev) throw notFound("Device");
      let inserted = 0;
      const rows = body.punches
        .map((p) => ({ userId: p.userId.trim().slice(0, 24), punchAt: new Date(p.punchAt), status: p.status ?? null, punch: p.punch ?? null }))
        .filter((p) => p.userId && !isNaN(p.punchAt.getTime()));
      if (rows.length) {
        // SQL Server has no "insert … skip duplicates" in Prisma: drop the ones already stored.
        const min = new Date(Math.min(...rows.map((r) => r.punchAt.getTime())));
        const max = new Date(Math.max(...rows.map((r) => r.punchAt.getTime())));
        const have = await prisma.attendancePunch.findMany({ where: { deviceId, punchAt: { gte: min, lte: max } }, select: { userId: true, punchAt: true } });
        const key = (u: string, d: Date) => `${u}|${d.getTime()}`;
        const seen = new Set(have.map((h) => key(h.userId, h.punchAt)));
        const fresh = rows.filter((r) => { const k = key(r.userId, r.punchAt); if (seen.has(k)) return false; seen.add(k); return true; });
        for (let i = 0; i < fresh.length; i += 500) {
          const r = await prisma.attendancePunch.createMany({ data: fresh.slice(i, i + 500).map((p) => ({ ...p, deviceId })) });
          inserted += r.count;
        }
      }
      const info = body.info ?? {};
      await prisma.attendanceDevice.update({
        where: { id: deviceId },
        data: {
          lastPullAt: new Date(), lastOkAt: new Date(), lastError: null,
          ...(info.serial ? { serial: info.serial.slice(0, 64) } : {}),
          ...(info.firmware ? { firmware: info.firmware.slice(0, 64) } : {}),
          ...(info.records != null ? { records: info.records } : {}),
          ...(info.clockOffsetSec != null ? { clockOffsetSec: info.clockOffsetSec } : {}),
        },
      });
      return { received: rows.length, inserted };
    },
    {
      body: t.Object({
        punches: t.Array(t.Object({ userId: t.String(), punchAt: t.String(), status: t.Optional(t.Nullable(t.Integer())), punch: t.Optional(t.Nullable(t.Integer())) }), { maxItems: 5000 }),
        info: t.Optional(t.Object({
          serial: t.Optional(t.String()), firmware: t.Optional(t.String()),
          records: t.Optional(t.Integer()), clockOffsetSec: t.Optional(t.Integer()),
        })),
      }),
    },
  )
  .post(
    "/devices/:id/error",
    async ({ params, body }) => {
      await prisma.attendanceDevice.update({ where: { id: Number(params.id) }, data: { lastPullAt: new Date(), lastError: body.error.slice(0, 500) } });
      return { ok: true };
    },
    { body: t.Object({ error: t.String() }) },
  );

export const attendanceRoutes = new Elysia({ prefix: "/attendance" })
  .use(authGuard)
  /** Pull schedule: manual only, or also automatically once a day at dailyAt (Bangkok). */
  .get("/pull", () => publicPullState())
  .put("/pull", async ({ body, user }) => {
    const r = await updatePullSettings(body.auto, body.dailyAt);
    await audit(user.id, "ATTENDANCE_PULL_SCHEDULE", "Setting", "attendance.pull", body);
    return r;
  }, { body: t.Object({ auto: t.Boolean(), dailyAt: t.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }) }) })
  .post("/pull/now", ({ user }) => requestPull(user.displayName ?? user.username))
  .get("/devices", async () => {
    const devs = await prisma.attendanceDevice.findMany({ orderBy: { alias: "asc" } });
    const counts = await prisma.attendancePunch.groupBy({ by: ["deviceId"], _count: true, _max: { punchAt: true } });
    const by = new Map(counts.map((c) => [c.deviceId, c]));
    return devs.map((d) => ({ ...d, stored: by.get(d.id)?._count ?? 0, lastPunchAt: by.get(d.id)?._max.punchAt ?? null }));
  })
  /** Scans in a time range (≤ 7 days), with the employee's name when the user id is a known code. */
  .get(
    "/punches",
    async ({ query }) => {
      const from = new Date(query.from);
      const to = new Date(query.to);
      if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) throw badRequest("Invalid time range");
      if (to.getTime() - from.getTime() > 7 * 86400_000) throw badRequest("Range too long (max 7 days)");
      const q = query.q?.trim();
      const rows = await prisma.attendancePunch.findMany({
        where: { punchAt: { gte: from, lt: to }, ...(q ? { userId: { contains: q } } : {}) },
        orderBy: { punchAt: "asc" },
        take: 50000,
        include: { device: { select: { alias: true, floor: true } } },
      });
      const emps = await employees();
      return rows.map((r) => ({
        id: r.id, userId: r.userId, empName: emps.get(r.userId)?.name ?? emps.get(r.userId.padStart(4, "0"))?.name ?? null,
        punchAt: r.punchAt, device: r.device.alias, floor: r.device.floor, status: r.status,
      }));
    },
    { query: t.Object({ from: t.String(), to: t.String(), q: t.Optional(t.String()) }) },
  )
  /**
   * One day, per employee: fingerprint scans + camera entry/exit passes, with review flags.
   * Camera passes = MATCHED (optionally also UNCERTAIN) face events, people standing still in the
   * zone excluded, same person + direction within GROUP_MS merged (IN keeps the first time, OUT the last).
   */
  .get(
    "/compare",
    async ({ query }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(query.day)) throw badRequest("day must be YYYY-MM-DD");
      const from = new Date(`${query.day}T00:00:00+07:00`);
      const to = new Date(from.getTime() + 86400_000);
      const GROUP_MS = 30 * 60_000;
      const statuses = query.uncertain === "1" ? ["MATCHED", "UNCERTAIN"] : ["MATCHED"];
      const [scans, events, emps] = await Promise.all([
        prisma.attendancePunch.findMany({ where: { punchAt: { gte: from, lt: to } }, orderBy: { punchAt: "asc" }, include: { device: { select: { alias: true, floor: true, clockOffsetSec: true } } } }),
        prisma.accessEvent.findMany({
          where: { firstSeenAt: { gte: from, lt: to }, status: { in: statuses }, empCode: { not: null } },
          orderBy: { firstSeenAt: "asc" },
          include: { camera: { select: { deviceNo: true, recordEnabled: true } } },
        }),
        employees(),
      ]);
      const code = (u: string) => (/^\d{1,3}$/.test(u) ? u.padStart(4, "0") : u);
      type Pass = { at: Date; first: Date; last: Date; direction: string; status: string; cameraId: number; deviceNo: string; recorded: boolean; count: number; eventId: number; snapshotUrl: string | null; byScan: boolean };
      const people = new Map<string, { scans: { at: Date; device: string; floor: string | null; clockOffsetSec: number | null }[]; passes: Pass[] }>();
      const get = (c: string) => { let p = people.get(c); if (!p) { p = { scans: [], passes: [] }; people.set(c, p); } return p; };
      for (const s of scans) get(code(s.userId)).scans.push({ at: s.punchAt, device: s.device.alias, floor: s.device.floor, clockOffsetSec: s.device.clockOffsetSec });
      const open = new Map<string, Pass>();
      for (const e of events) {
        // someone standing in the zone is not a passage
        if (e.travelY != null && e.sizeGrowth != null && e.frames >= 8 && Math.abs(e.travelY) < 0.04 && e.sizeGrowth > 0.85 && e.sizeGrowth < 1.2) continue;
        const c = e.empCode!;
        const k = `${c}|${e.direction}|${e.status}`;
        const g = open.get(k);
        if (g && e.firstSeenAt.getTime() - g.last.getTime() <= GROUP_MS) {
          if (e.lastSeenAt > g.last) g.last = e.lastSeenAt;
          g.count++;
          g.at = g.direction === "IN" ? g.first : g.last;
          continue;
        }
        const n: Pass = {
          first: e.firstSeenAt, last: e.lastSeenAt, at: e.direction === "IN" ? e.firstSeenAt : e.lastSeenAt, direction: e.direction, status: e.status,
          cameraId: e.cameraId, deviceNo: e.camera.deviceNo, recorded: e.camera.recordEnabled, count: 1, eventId: e.id,
          snapshotUrl: e.snapshotPath ? faceMediaUrl("snap", e.id) : null,
          byScan: e.confirmedBy === "SCAN" && !e.reviewedAt,
        };
        get(c).passes.push(n);
        open.set(k, n);
      }
      const out = [...people.entries()].map(([c, p]) => {
        const emp = emps.get(c);
        const ins = p.passes.filter((x) => x.direction === "IN");
        const outs = p.passes.filter((x) => x.direction === "OUT");
        const flags: string[] = [];
        const noScanIns: number[] = [];
        for (const x of ins) {
          const t0 = x.at.getTime();
          if (!p.scans.some((s) => s.at.getTime() >= t0 - 10 * 60_000 && s.at.getTime() <= t0 + 30 * 60_000)) noScanIns.push(x.eventId);
        }
        if (p.passes.length && !p.scans.length) flags.push("NO_SCAN_DAY");
        else if (noScanIns.length) flags.push("NO_SCAN_AFTER_IN");
        if (p.scans.length && ins.length && p.scans[0]!.at.getTime() < ins[0]!.at.getTime() - 5 * 60_000) flags.push("SCAN_BEFORE_CAMERA");

        // ── shift periods ──
        type S = (typeof p.scans)[number];
        const pick = <T extends { at: Date }>(list: T[], w: { from: number; to: number }, last = false) => {
          const l = list.filter((x) => inWin(x.at, w));
          return (last ? l.at(-1) : l[0]) ?? null;
        };
        const sIn = pick(p.scans, PERIODS.IN);
        const sBreakOut = pick(p.scans, PERIODS.BREAK);
        let sBreakIn: S | null = pick(p.scans, PERIODS.BREAK, true);
        if (sBreakIn && sBreakOut && sBreakIn.at.getTime() - sBreakOut.at.getTime() < BREAK_GAP_MS) sBreakIn = null;
        const sOut = pick(p.scans, PERIODS.OUT, true);
        const cIn = pick(ins, PERIODS.IN);
        const cBreakOut = pick(outs, PERIODS.BREAK);
        const cBreakIn = pick(ins, PERIODS.BREAK, true);
        const cOut = pick(outs, PERIODS.OUT, true);
        const chosen = [sIn, sBreakOut, sBreakIn, sOut].filter(Boolean) as S[];
        const offScans = p.scans.filter((x) => !chosen.includes(x) && !chosen.some((c) => Math.abs(c.at.getTime() - x.at.getTime()) <= DOUBLE_MS));
        const chosenPasses = [cIn, cBreakOut, cBreakIn, cOut].filter(Boolean) as Pass[];
        const offPasses = p.passes.filter((x) => !chosenPasses.includes(x));
        if (offScans.length || offPasses.length) flags.push("OFF_HOURS");
        const periods = {
          IN: { scan: sIn, camera: cIn },
          BREAK_OUT: { scan: sBreakOut, camera: cBreakOut },
          BREAK_IN: { scan: sBreakIn, camera: cBreakIn },
          OUT: { scan: sOut, camera: cOut },
        };
        return {
          periods, offHours: { scans: offScans, passes: offPasses },
          code: c, name: emp?.name ?? null, photoUrl: emp?.photo ? faceMediaUrl("emp", c) : null, known: !!emp,
          scans: p.scans, passes: p.passes.sort((a, b) => a.at.getTime() - b.at.getTime()), noScanIns, flags,
          firstScan: p.scans[0]?.at ?? null, lastScan: p.scans.at(-1)?.at ?? null,
          firstIn: ins[0]?.at ?? null, lastOut: outs.at(-1)?.at ?? null,
        };
      });
      out.sort((a, b) => (a.firstScan ?? a.firstIn ?? to).getTime() - (b.firstScan ?? b.firstIn ?? to).getTime());
      const scanned = out.filter((p) => p.scans.length).length;
      return {
        day: query.day,
        summary: {
          scanned, seenByCamera: out.filter((p) => p.passes.length).length,
          both: out.filter((p) => p.scans.length && p.passes.length).length,
          flagged: out.filter((p) => p.flags.some((f) => f !== "OFF_HOURS")).length,
          offHours: out.filter((p) => p.flags.includes("OFF_HOURS")).length,
          devices: await prisma.attendanceDevice.count(),
        },
        periods: PERIODS,
        people: out,
      };
    },
    { query: t.Object({ day: t.String(), uncertain: t.Optional(t.String()) }) },
  );
