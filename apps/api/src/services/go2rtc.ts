/** Thin client for the go2rtc HTTP API. */
import { env } from "../lib/env.ts";
import { prisma } from "../lib/prisma.ts";
import { buildSources, streamName } from "./streams.ts";

const base = env.go2rtcUrl;

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base}/api${path}`, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`go2rtc ${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

export interface Go2rtcStreamInfo {
  producers?: { url?: string; medias?: string[]; recv?: number }[];
  consumers?: { url?: string; send?: number }[];
}

export async function listStreams(): Promise<Record<string, Go2rtcStreamInfo>> {
  const res = await api("/streams");
  return (await res.json()) as Record<string, Go2rtcStreamInfo>;
}

export async function putStream(name: string, src: string) {
  const q = new URLSearchParams({ name, src });
  await api(`/streams?${q.toString()}`, { method: "PUT" });
}

export async function deleteStream(name: string) {
  const q = new URLSearchParams({ src: name });
  await api(`/streams?${q.toString()}`, { method: "DELETE" });
}

export async function isReachable(): Promise<boolean> {
  try {
    await api("/streams");
    return true;
  } catch {
    return false;
  }
}

/** Registers (or refreshes) one camera's main and sub streams in go2rtc. */
export async function syncCamera(cameraId: number) {
  const cam = await prisma.camera.findUnique({ where: { id: cameraId }, include: { nvr: true } });
  if (!cam) return { ok: false, reason: "camera not found" };
  const main = streamName(cam.id);
  const sub = streamName(cam.id, true);
  if (!cam.isEnabled) {
    await Promise.allSettled([deleteStream(main), deleteStream(sub)]);
    return { ok: true, removed: true };
  }
  const src = await buildSources(cam);
  if (!src) return { ok: false, reason: "camera has no usable stream source (missing host / NVR channel)" };
  await putStream(main, src.main);
  await putStream(sub, src.sub);
  return { ok: true };
}

/** Pushes every enabled camera into go2rtc. Safe to run on startup and after bulk imports. */
export async function syncAllCameras() {
  const cams = await prisma.camera.findMany({ where: { isEnabled: true }, include: { nvr: true } });
  let ok = 0;
  const skipped: { id: number; deviceNo: string; reason: string }[] = [];
  for (const cam of cams) {
    const src = await buildSources(cam);
    if (!src) {
      skipped.push({ id: cam.id, deviceNo: cam.deviceNo, reason: "no stream source" });
      continue;
    }
    try {
      await putStream(streamName(cam.id), src.main);
      await putStream(streamName(cam.id, true), src.sub);
      ok++;
    } catch (e) {
      skipped.push({ id: cam.id, deviceNo: cam.deviceNo, reason: (e as Error).message });
    }
  }
  return { total: cams.length, synced: ok, skipped };
}
