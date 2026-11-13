/**
 * When the fingerprint puller (apps/attendance/pull.py) should read the scanners.
 *
 * The puller no longer runs on a fixed interval: it asks GET /attendance/worker/next every few
 * seconds and only reads the scanners when this says so —
 *   - someone pressed "ดึงข้อมูลตอนนี้" (requestedAt), or
 *   - auto mode is on and today's chosen time (Bangkok) has passed and no run started since then.
 * State lives in the Setting table under one JSON key so it survives API restarts.
 */
import { prisma } from "../lib/prisma.ts";
import { confirmByScans } from "./scan-confirm.ts";

const KEY = "attendance.pull";
const STALE_RUN_MS = 20 * 60_000; // a run that never reported back (puller killed) stops counting as running
const TZ_MS = 7 * 3600_000;

export interface PullState {
  auto: boolean;
  dailyAt: string; // "HH:MM" Bangkok
  requestedAt: string | null;
  requestedBy: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastReason: "manual" | "auto" | null;
  lastInserted: number | null;
  lastFailed: number | null;
  autoSkipUntil: string | null; // auto turned on after today's time: today's slot counts as done
}
const DEFAULT: PullState = {
  auto: false, dailyAt: "23:30", requestedAt: null, requestedBy: null,
  lastStartedAt: null, lastFinishedAt: null, lastReason: null, lastInserted: null, lastFailed: null, autoSkipUntil: null,
};

let pullerSeenAt: Date | null = null; // last poll from the puller (memory only: "is it alive?")

/** Live progress of the current run (memory only). Percent is weighted by each scanner's stored
 *  record count from the previous pull, since reading time grows with the log size. */
interface Progress { total: number; done: number[]; current: { id: number; alias: string } | null; updatedAt: number }
let progress: Progress | null = null;

export async function reportProgress(p: { total: number; deviceId: number; alias: string; phase: "start" | "done" }) {
  if (!progress) progress = { total: p.total, done: [], current: null, updatedAt: Date.now() };
  progress.total = p.total;
  if (p.phase === "start") progress.current = { id: p.deviceId, alias: p.alias };
  else { if (!progress.done.includes(p.deviceId)) progress.done.push(p.deviceId); progress.current = null; }
  progress.updatedAt = Date.now();
}
async function progressView() {
  if (!progress) return null;
  const devs = await prisma.attendanceDevice.findMany({ where: { enabled: true }, select: { id: true, records: true } });
  const w = (id: number) => Math.max(1000, devs.find((d) => d.id === id)?.records ?? 1000);
  const total = devs.reduce((t, d) => t + w(d.id), 0) || 1;
  const done = progress.done.reduce((t, id) => t + w(id), 0);
  // half credit for the scanner being read right now so the bar keeps moving
  const cur = progress.current ? w(progress.current.id) / 2 : 0;
  return {
    percent: Math.min(99, Math.round(((done + cur) / total) * 100)),
    done: progress.done.length, total: progress.total, current: progress.current?.alias ?? null,
    updatedAt: new Date(progress.updatedAt).toISOString(),
  };
}

export async function getPullState(): Promise<PullState> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } }).catch(() => null);
  if (!row) return { ...DEFAULT };
  try { return { ...DEFAULT, ...(JSON.parse(row.value) as Partial<PullState>) }; } catch { return { ...DEFAULT }; }
}
async function save(s: PullState) {
  const value = JSON.stringify(s);
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

/** Today's scheduled moment (UTC Date) for "HH:MM" Bangkok time. */
function todaysSlot(dailyAt: string, now = new Date()): Date {
  const [h, m] = dailyAt.split(":").map(Number);
  const local = new Date(now.getTime() + TZ_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h!, m!) - TZ_MS);
}
const isRunning = (s: PullState, now = Date.now()) =>
  !!s.lastStartedAt && (!s.lastFinishedAt || s.lastFinishedAt < s.lastStartedAt) && now - Date.parse(s.lastStartedAt) < STALE_RUN_MS;

export async function publicPullState() {
  const s = await getPullState();
  const now = new Date();
  let nextAutoAt: string | null = null;
  if (s.auto) {
    const slot = todaysSlot(s.dailyAt, now);
    nextAutoAt = (slot > now ? slot : new Date(slot.getTime() + 86_400_000)).toISOString();
  }
  const running = isRunning(s);
  return { ...s, running, nextAutoAt, pullerSeenAt: pullerSeenAt?.toISOString() ?? null, progress: running ? await progressView() : null };
}

export async function updatePullSettings(auto: boolean, dailyAt: string) {
  const s = await getPullState();
  s.auto = auto;
  s.dailyAt = dailyAt;
  // turning auto on after today's time already passed must not fire immediately: count today as done
  if (auto && todaysSlot(dailyAt) <= new Date() && (!s.lastStartedAt || new Date(s.lastStartedAt) < todaysSlot(dailyAt))) {
    s.autoSkipUntil = todaysSlot(dailyAt).toISOString();
  }
  await save(s);
  return publicPullState();
}

export async function requestPull(by: string) {
  const s = await getPullState();
  if (!isRunning(s)) { s.requestedAt = new Date().toISOString(); s.requestedBy = by; await save(s); }
  return publicPullState();
}

/** Puller poll: should it read the scanners now? Marks the run as started when yes. */
export async function nextRun(): Promise<{ run: boolean; reason?: "manual" | "auto" }> {
  pullerSeenAt = new Date();
  const s = await getPullState();
  if (isRunning(s)) return { run: false };
  let reason: "manual" | "auto" | null = null;
  if (s.requestedAt) reason = "manual";
  else if (s.auto) {
    const slot = todaysSlot(s.dailyAt);
    const done = (s.lastStartedAt && new Date(s.lastStartedAt) >= slot) || (s.autoSkipUntil && new Date(s.autoSkipUntil) >= slot);
    if (slot <= new Date() && !done) reason = "auto";
  }
  if (!reason) return { run: false };
  s.lastStartedAt = new Date().toISOString();
  progress = null;
  s.lastReason = reason;
  s.requestedAt = null;
  s.requestedBy = null;
  await save(s);
  return { run: true, reason };
}

export async function finishRun(inserted: number, failed: number) {
  const s = await getPullState();
  const prevFinished = s.lastFinishedAt;
  s.lastFinishedAt = new Date().toISOString();
  progress = null;
  s.lastInserted = inserted;
  s.lastFailed = failed;
  await save(s);
  // Scans can now arrive hours after the face events: confirm everything since the previous pull
  // (minus a margin), not just the scheduler's last 6 h.
  if (inserted > 0) {
    const since = new Date(Math.max(Date.now() - 30 * 86_400_000, (prevFinished ? Date.parse(prevFinished) : 0) - 24 * 3600_000));
    confirmByScans(since).then((r) => r.confirmed && console.log("[scan-confirm] after pull", r)).catch((e) => console.error("[scan-confirm]", e));
  }
}
