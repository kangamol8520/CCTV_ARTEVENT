/**
 * Face entry/exit log (Phase 3) helpers shared by the API routes.
 *
 * The recognition itself runs in the Python worker (apps/face/worker.py). It reads its camera
 * config from, and posts events to, /api/face/worker/* using a token derived from APP_SECRET,
 * so the worker never needs a user account and the API stays the only database writer.
 *
 * Disk layout under FACE_DATA_DIR:
 *   gallery.npz                         employee face templates (built by enroll.py; never served)
 *   events/<yyyy-MM-dd>/<uuid>.jpg      snapshot of each passing face (deleted by the worker after N days)
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { env } from "../lib/env.ts";

export const FACE_STATUS_KEY = "face.status";

export interface FaceWorkerStatus {
  pid: number;
  startedAt: string;
  updatedAt: string;
  gallery: { employees: number; templates: number; loadedAt: string } | null;
  cameras: { cameraId: number; running: boolean; fps: number; processedFps: number; busyPct: number; tracks: number; events: number; lastError: string | null }[];
}

// ── Worker auth ──────────────────────────────────────────────────────────────────────────────
// The worker computes the same HMAC from APP_SECRET (it reads apps/api/.env), so nothing extra
// has to be provisioned. Rotating APP_SECRET rotates the worker token too.
export const workerToken = () => createHmac("sha256", env.appSecret).update("face-worker").digest("hex");

export function verifyWorker(header: string | null) {
  if (!header) return false;
  const a = Buffer.from(workerToken());
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Signed media URLs (an <img> cannot send the bearer header) ─────────────────────────────
const MEDIA_TTL_S = 6 * 60 * 60;
const sign = (kind: string, id: string, exp: number) =>
  createHmac("sha256", env.appSecret).update(`face-media:${kind}:${id}:${exp}`).digest("base64url");

export function faceMediaUrl(kind: "snap" | "emp", id: string | number) {
  const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL_S;
  return `/api/face/media/${kind}/${encodeURIComponent(String(id))}?exp=${exp}&sig=${sign(kind, String(id), exp)}`;
}

export function verifyFaceMedia(kind: string, id: string, exp: number, sig: string) {
  if (!isFinite(exp) || exp < Date.now() / 1000) return false;
  const a = Buffer.from(sign(kind, id, exp));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Resolves a path under `root`, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string) {
  const p = resolve(root, rel);
  return p.startsWith(resolve(root) + sep) ? p : null;
}

// ── Employee directory (Emp.json) ───────────────────────────────────────────────────────────
// Loaded lazily and reloaded when the file changes. Later this can switch to the HR API
// (workspace-ae /api/v2/getemployee) once the network allows it.
interface EmpRow { EmpCode: string; EmpName: string; PictPath?: string | null }
export interface Employee { code: string; name: string; photo: string | null }

let cache: { mtime: number; byCode: Map<string, Employee> } | null = null;

export async function employees(): Promise<Map<string, Employee>> {
  const file = join(env.employeesDir, "Emp.json");
  let mtime = 0;
  try {
    mtime = (await stat(file)).mtimeMs;
  } catch {
    return new Map();
  }
  if (cache && cache.mtime === mtime) return cache.byCode;
  const rows = (await Bun.file(file).json()) as EmpRow[];
  const photosDir = join(env.employeesDir, "photos");
  const names = new Map<string, string>();
  try {
    for (const f of await Array.fromAsync(new Bun.Glob("*").scan({ cwd: photosDir, onlyFiles: true }))) {
      names.set(f.toLowerCase(), f);
      names.set(f.toLowerCase().replace(/\.[^.]+$/, ""), f);
    }
  } catch {}
  const byCode = new Map<string, Employee>();
  for (const r of rows) {
    const code = String(r.EmpCode).trim();
    const base = (r.PictPath ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
    const photo = names.get(base) ?? names.get(code.toLowerCase()) ?? null;
    byCode.set(code, { code, name: String(r.EmpName ?? "").trim(), photo });
  }
  cache = { mtime, byCode };
  return byCode;
}
