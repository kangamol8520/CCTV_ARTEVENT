/**
 * Central recording helpers shared by the recorder process (src/recorder.ts) and the API.
 *
 * Disk layout under RECORDINGS_DIR:
 *   <cameraId>/.incoming/<yyyyMMddTHHmmssZ>.mp4   fragmented MP4 being written by ffmpeg (crash-safe)
 *   <cameraId>/<yyyy-MM-dd>/<yyyyMMddTHHmmssZ>.mp4  finalized file (remuxed, +faststart), indexed in Recording
 * File names are the UTC wall-clock time the segment started.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { env } from "../lib/env.ts";

export const cameraDir = (cameraId: number) => join(env.recordingsDir, String(cameraId));
export const incomingDir = (cameraId: number) => join(cameraDir(cameraId), ".incoming");

const NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.mp4$/;

/** Parses the UTC start time encoded in a segment file name. */
export function parseSegmentName(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
  return isNaN(t) ? null : new Date(t);
}

export interface ProbeResult {
  durationMs: number;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

export async function probe(file: string): Promise<ProbeResult | null> {
  const p = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", file],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) return null;
  try {
    const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type: string; codec_name: string; width?: number; height?: number }[] };
    const dur = Number(j.format?.duration);
    if (!isFinite(dur) || dur <= 0) return null;
    const v = j.streams?.find((s) => s.codec_type === "video");
    return {
      durationMs: Math.round(dur * 1000),
      videoCodec: v?.codec_name ?? null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      hasAudio: !!j.streams?.some((s) => s.codec_type === "audio"),
    };
  } catch {
    return null;
  }
}

/** Free / total bytes of the filesystem holding `dir` (POSIX `df`). */
export async function diskUsage(dir: string): Promise<{ totalBytes: number; freeBytes: number } | null> {
  const p = Bun.spawn(["df", "-Pk", dir], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) return null;
  const cols = out.trim().split("\n").at(-1)?.split(/\s+/);
  if (!cols || cols.length < 4) return null;
  return { totalBytes: Number(cols[1]) * 1024, freeBytes: Number(cols[3]) * 1024 };
}

// ── Signed media URLs ────────────────────────────────────────────────────────────────────────
// <video src> cannot send an Authorization header, so file URLs carry a short-lived HMAC
// signature issued by an authenticated endpoint instead of the user's JWT.
const MEDIA_TTL_S = 6 * 60 * 60;

function sign(recordingId: number, exp: number) {
  return createHmac("sha256", env.appSecret).update(`rec-media:${recordingId}:${exp}`).digest("base64url");
}

export function mediaUrl(recordingId: number) {
  const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL_S;
  return `/api/recordings/media/${recordingId}?exp=${exp}&sig=${sign(recordingId, exp)}`;
}

export function verifyMedia(recordingId: number, exp: number, sig: string) {
  if (!isFinite(exp) || exp < Date.now() / 1000) return false;
  const a = Buffer.from(sign(recordingId, exp));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const RECORDER_STATUS_KEY = "recorder.status";

export interface RecorderStatus {
  pid: number;
  startedAt: string;
  updatedAt: string;
  recordingsDir: string;
  cameras: { cameraId: number; stream: string; running: boolean; since: string | null; restarts: number; lastError: string | null }[];
}
