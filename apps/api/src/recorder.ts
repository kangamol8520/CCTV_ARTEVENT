/**
 * Central recorder (Phase 2) — a separate long-running process: `bun run recorder`.
 *
 * Kept out of the API process on purpose: the API restarts on every code change in dev
 * (`bun --watch`) and recording must not stop with it.
 *
 *  1. Reconcile (every 15 s): one ffmpeg per camera with recordEnabled=true. ffmpeg records the
 *     go2rtc restream (rtsp://127.0.0.1:8554/cam-<id>) so the camera gets no extra connection.
 *     Video is copied as-is (no transcode); G.711 audio becomes AAC so it fits in MP4.
 *     Output is fragmented MP4 in 60 s segments aligned to the clock → survives crashes.
 *  2. Index (every 10 s): finished segments are remuxed to a normal +faststart MP4 (fast seeking
 *     in the browser, hvc1 tag for HEVC), moved into a per-day folder and inserted into Recording.
 *  3. Retention (every 10 min): delete files older than RECORDING_RETENTION_DAYS, and the oldest
 *     files first whenever free space drops below RECORDING_MIN_FREE_GB.
 */
import { mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Subprocess } from "bun";
import { env } from "./lib/env.ts";
import { prisma } from "./lib/prisma.ts";
import { streamName } from "./services/streams.ts";
import {
  cameraDir, diskUsage, incomingDir, parseSegmentName, probe, RECORDER_STATUS_KEY, type RecorderStatus,
} from "./services/recordings.ts";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[recorder]", ...a);

interface Job {
  cameraId: number;
  stream: string;
  proc: Subprocess<"ignore", "ignore", "pipe"> | null;
  since: Date | null;
  restarts: number;
  lastError: string | null;
  retryAt: number;
  wanted: boolean;
}

const jobs = new Map<number, Job>();
const startedAt = new Date();
let stopping = false;

// ── ffmpeg ──────────────────────────────────────────────────────────────────────────────────
function ffmpegArgs(cameraId: number, stream: string) {
  return [
    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "warning",
    "-rtsp_transport", "tcp", "-timeout", "15000000",
    "-i", `${env.go2rtcRtspUrl}/${stream}`,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "32k",
    "-f", "segment", "-segment_time", String(env.recordingSegmentSeconds), "-segment_atclocktime", "1",
    "-reset_timestamps", "1", "-strftime", "1",
    "-segment_format", "mp4", "-segment_format_options", "movflags=+frag_keyframe+empty_moov+default_base_moof",
    join(incomingDir(cameraId), "%Y%m%dT%H%M%SZ.mp4"),
  ];
}

async function start(job: Job) {
  await mkdir(incomingDir(job.cameraId), { recursive: true });
  const proc = Bun.spawn(ffmpegArgs(job.cameraId, job.stream), {
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
    env: { ...process.env, TZ: "UTC" }, // strftime file names are UTC
  });
  job.proc = proc;
  job.since = new Date();
  log(`cam ${job.cameraId}: started ffmpeg pid ${proc.pid} (${job.stream})`);

  // Keep the last stderr line as the visible error.
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) {
      const lines = dec.decode(chunk).trim().split("\n").filter(Boolean);
      if (lines.length) job.lastError = lines.at(-1)!.slice(0, 300);
    }
  })().catch(() => {});

  proc.exited.then((code) => {
    if (job.proc !== proc) return;
    job.proc = null;
    job.since = null;
    if (stopping || !job.wanted) return;
    job.restarts++;
    const backoff = Math.min(60_000, 5_000 * Math.min(job.restarts, 12));
    job.retryAt = Date.now() + backoff;
    log(`cam ${job.cameraId}: ffmpeg exited (${code}); retry in ${backoff / 1000}s — ${job.lastError ?? ""}`);
  });
}

async function stop(job: Job) {
  const proc = job.proc;
  if (!proc) return;
  proc.kill("SIGINT"); // lets ffmpeg close the current fragment cleanly
  const t = setTimeout(() => proc.kill("SIGKILL"), 5000);
  await proc.exited;
  clearTimeout(t);
}

// Watchdog: ffmpeg can hang without exiting — e.g. when a camera's codec changes (H.264 → H.265)
// go2rtc reconnects with the new codec but ffmpeg keeps waiting for packets of the old one.
// If the newest incoming file stops growing, kill ffmpeg; the exit handler restarts it.
const STALL_MS = 45_000;
async function checkStall(job: Job) {
  let newest = 0;
  try {
    for (const f of await readdir(incomingDir(job.cameraId))) {
      if (parseSegmentName(f)) newest = Math.max(newest, (await stat(join(incomingDir(job.cameraId), f))).mtimeMs);
    }
  } catch {}
  if (Date.now() - newest > STALL_MS) {
    job.lastError = `stalled: no data for ${Math.round((Date.now() - newest) / 1000)}s, restarting`;
    log(`cam ${job.cameraId}: ${job.lastError}`);
    await stop(job);
  }
}

async function reconcile() {
  const cams = await prisma.camera.findMany({ where: { recordEnabled: true, isEnabled: true }, select: { id: true, recordStream: true } });
  const want = new Map(cams.map((c) => [c.id, streamName(c.id, c.recordStream === "SUB")]));

  for (const [id, job] of jobs) {
    if (want.get(id) !== job.stream) {
      job.wanted = false;
      await stop(job);
      jobs.delete(id);
      log(`cam ${id}: recording stopped`);
    }
  }
  for (const [id, stream] of want) {
    let job = jobs.get(id);
    if (!job) {
      job = { cameraId: id, stream, proc: null, since: null, restarts: 0, lastError: null, retryAt: 0, wanted: true };
      jobs.set(id, job);
    }
    if (!job.proc && Date.now() >= job.retryAt) await start(job);
    else if (job.proc && job.since && Date.now() - job.since.getTime() > STALL_MS) await checkStall(job);
    // A job that has run for 10 min is considered healthy again → reset the backoff.
    if (job.proc && job.since && Date.now() - job.since.getTime() > 600_000) job.restarts = 0;
  }
  await writeStatus();
}

async function writeStatus() {
  const status: RecorderStatus = {
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    updatedAt: new Date().toISOString(),
    recordingsDir: env.recordingsDir,
    cameras: [...jobs.values()].map((j) => ({
      cameraId: j.cameraId, stream: j.stream, running: !!j.proc, since: j.since?.toISOString() ?? null, restarts: j.restarts, lastError: j.lastError,
    })),
  };
  const value = JSON.stringify(status);
  await prisma.setting.upsert({ where: { key: RECORDER_STATUS_KEY }, create: { key: RECORDER_STATUS_KEY, value }, update: { value } });
}

// ── Indexing ────────────────────────────────────────────────────────────────────────────────
async function listDirs(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

async function remux(src: string, dst: string, hevc: boolean) {
  const p = Bun.spawn(
    ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0", "-c", "copy",
      ...(hevc ? ["-tag:v", "hvc1"] : []), "-movflags", "+faststart", dst],
    { stdout: "ignore", stderr: "pipe" },
  );
  const err = await new Response(p.stderr).text();
  return (await p.exited) === 0 ? null : err.trim().slice(0, 300) || "remux failed";
}

async function indexCamera(cameraId: number) {
  const inc = incomingDir(cameraId);
  let files: string[];
  try {
    files = (await readdir(inc)).filter((f) => parseSegmentName(f)).sort();
  } catch {
    return;
  }
  // While ffmpeg runs, the newest file is still being written.
  if (jobs.get(cameraId)?.proc) files = files.slice(0, -1);

  for (const name of files) {
    const src = join(inc, name);
    const start = parseSegmentName(name)!;
    const info = await probe(src);
    if (!info || info.durationMs < 1000) {
      await rm(src, { force: true });
      continue;
    }
    const day = name.slice(0, 4) + "-" + name.slice(4, 6) + "-" + name.slice(6, 8);
    const dayDir = join(cameraDir(cameraId), day);
    await mkdir(dayDir, { recursive: true });
    const dst = join(dayDir, name);
    const err = await remux(src, dst, info.videoCodec === "hevc");
    if (err) {
      // Keep the playable fragmented original rather than losing footage.
      log(`cam ${cameraId}: remux ${name} failed, keeping fragmented file — ${err}`);
      await rename(src, dst);
    } else {
      await rm(src, { force: true });
    }
    const final = (await probe(dst)) ?? info;
    const size = (await stat(dst)).size;
    const filePath = relative(env.recordingsDir, dst);
    await prisma.recording.upsert({
      where: { filePath },
      create: {
        cameraId, filePath, startedAt: start, endedAt: new Date(start.getTime() + final.durationMs), durationMs: final.durationMs,
        sizeBytes: BigInt(size), videoCodec: final.videoCodec, width: final.width, height: final.height, hasAudio: final.hasAudio,
      },
      update: { sizeBytes: BigInt(size), durationMs: final.durationMs, endedAt: new Date(start.getTime() + final.durationMs) },
    });
  }
}

let indexing = false;
async function indexAll() {
  if (indexing) return;
  indexing = true;
  try {
    for (const d of await listDirs(env.recordingsDir)) {
      const id = Number(d);
      if (Number.isInteger(id)) await indexCamera(id);
    }
  } finally {
    indexing = false;
  }
}

// ── Retention ───────────────────────────────────────────────────────────────────────────────
async function deleteRecordings(rows: { id: number; filePath: string }[]) {
  for (const r of rows) await rm(join(env.recordingsDir, r.filePath), { force: true });
  if (rows.length) await prisma.recording.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
}

async function retention() {
  const cutoff = new Date(Date.now() - env.recordingRetentionDays * 86_400_000);
  for (;;) {
    const old = await prisma.recording.findMany({ where: { endedAt: { lt: cutoff } }, select: { id: true, filePath: true }, take: 500 });
    if (!old.length) break;
    await deleteRecordings(old);
    log(`retention: deleted ${old.length} files older than ${env.recordingRetentionDays} days`);
  }
  // Disk guard: free space below the floor → drop the oldest hour (across all cameras) at a time.
  const minFree = env.recordingMinFreeGb * 1e9;
  for (let i = 0; i < 200; i++) {
    const du = await diskUsage(env.recordingsDir);
    if (!du || du.freeBytes >= minFree) break;
    const oldest = await prisma.recording.findMany({ orderBy: { startedAt: "asc" }, select: { id: true, filePath: true }, take: 60 });
    if (!oldest.length) break;
    await deleteRecordings(oldest);
    log(`disk guard: free ${(du.freeBytes / 1e9).toFixed(1)} GB < ${env.recordingMinFreeGb} GB, deleted ${oldest.length} oldest files`);
  }
  // Remove empty day folders.
  for (const cam of await listDirs(env.recordingsDir)) {
    for (const day of await listDirs(cameraDir(Number(cam)))) {
      if (day.startsWith(".")) continue;
      await rmdir(join(cameraDir(Number(cam)), day)).catch(() => {}); // fails (fine) when not empty
    }
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────────────────────
function every(ms: number, name: string, fn: () => Promise<unknown>) {
  const run = () => fn().catch((e) => log(`${name} error:`, (e as Error).message));
  run();
  return setInterval(run, ms);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("shutting down…");
  await Promise.all([...jobs.values()].map(stop));
  jobs.clear();
  await indexAll().catch(() => {});
  await writeStatus().catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await mkdir(env.recordingsDir, { recursive: true });
log(`recordings dir ${env.recordingsDir}, segment ${env.recordingSegmentSeconds}s, retention ${env.recordingRetentionDays}d, min free ${env.recordingMinFreeGb} GB`);
await indexAll(); // leftovers from a previous run are complete
every(15_000, "reconcile", reconcile);
every(10_000, "index", indexAll);
every(600_000, "retention", retention);
