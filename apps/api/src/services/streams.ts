/**
 * Builds go2rtc stream sources for a camera.
 * Stream naming convention (used by the frontend as well):
 *   cam-<id>       main stream (recording / full-screen)
 *   cam-<id>-sub   sub stream  (grid view)
 */
import type { Camera, Nvr } from "@prisma/client";
import { decryptSecret } from "../lib/crypto.ts";

export type CameraWithNvr = Camera & { nvr: Nvr | null };

export const streamName = (cameraId: number, sub = false) => `cam-${cameraId}${sub ? "-sub" : ""}`;

function rtspUrl(host: string, port: number, path: string, user?: string | null, pass?: string | null) {
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass ?? "")}@` : "";
  return `rtsp://${auth}${host}:${port}${path.startsWith("/") ? path : "/" + path}`;
}

/** Returns [mainSource, subSource] or null when the camera cannot be streamed yet. */
export async function buildSources(cam: CameraWithNvr): Promise<{ main: string; sub: string } | null> {
  switch (cam.protocol) {
    case "NVR_CHANNEL": {
      if (!cam.nvr || !cam.nvrChannel) return null;
      const pass = await decryptSecret(cam.nvr.passwordEnc);
      const ch = String(cam.nvrChannel);
      return {
        main: rtspUrl(cam.nvr.host, cam.nvr.rtspPort, cam.nvr.channelMainPath.replace("{ch}", ch), cam.nvr.username, pass),
        sub: rtspUrl(cam.nvr.host, cam.nvr.rtspPort, cam.nvr.channelSubPath.replace("{ch}", ch), cam.nvr.username, pass),
      };
    }
    case "HIKVISION": {
      if (!cam.host) return null;
      const pass = await decryptSecret(cam.passwordEnc);
      return {
        main: rtspUrl(cam.host, cam.rtspPort, cam.mainStreamPath ?? "/Streaming/Channels/101", cam.username, pass),
        sub: rtspUrl(cam.host, cam.rtspPort, cam.subStreamPath ?? "/Streaming/Channels/102", cam.username, pass),
      };
    }
    case "RTSP": {
      if (!cam.host || !cam.mainStreamPath) return null;
      const pass = await decryptSecret(cam.passwordEnc);
      const main = rtspUrl(cam.host, cam.rtspPort, cam.mainStreamPath, cam.username, pass);
      return { main, sub: cam.subStreamPath ? rtspUrl(cam.host, cam.rtspPort, cam.subStreamPath, cam.username, pass) : main };
    }
    case "ONVIF":
    default: {
      if (!cam.host) return null;
      const pass = await decryptSecret(cam.passwordEnc);
      const auth = cam.username ? `${encodeURIComponent(cam.username)}:${encodeURIComponent(pass ?? "")}@` : "";
      // go2rtc resolves the RTSP URI through ONVIF GetStreamUri; subtype = media profile index.
      const base = `onvif://${auth}${cam.host}:${cam.httpPort}`;
      return { main: `${base}?subtype=0`, sub: `${base}?subtype=1` };
    }
  }
}

/** Hikvision playback source via the NVR (RTSP track with time range). Times in UTC. */
export async function buildPlaybackSource(cam: CameraWithNvr, start: Date, end: Date): Promise<string | null> {
  if (!cam.nvr || !cam.nvrChannel) return null;
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const pass = await decryptSecret(cam.nvr.passwordEnc);
  const path = cam.nvr.playbackPath
    .replace("{ch}", String(cam.nvrChannel))
    .replace("{start}", fmt(start))
    .replace("{end}", fmt(end));
  return rtspUrl(cam.nvr.host, cam.nvr.rtspPort, path, cam.nvr.username, pass);
}
