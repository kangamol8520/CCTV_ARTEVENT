/**
 * Reusable camera stream discovery: given a host, find the protocol/port/RTSP paths and the
 * working password, verify a frame, and (applyDiscovery) persist + re-sync the go2rtc stream.
 * Used by scripts/discover-onvif.ts (bulk CLI) and by registry-sync on IP change.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../lib/prisma.ts";
import { encryptSecret } from "../lib/crypto.ts";
import { env } from "../lib/env.ts";
import { syncCamera } from "./go2rtc.ts";
import { tcpProbe } from "./health.ts";
import { digestFetch } from "./hikvision.ts";

const ONVIF_PORTS = [8080, 2020, 80, 8899, 443, 85, 8000, 5000];
const RTSP_FALLBACKS = [
  "/stander/livestream/0/0",
  "/user=admin&password={PW}&channel=1&stream=0.sdp?",
  "/cam/realmonitor?channel=1&subtype=0",
  "/live/ch0", "/live/ch00_0", "/live/main", "/11", "/0", "/1",
  "/h264/ch1/main/av_stream", "/stream1", "/Streaming/Channels/101",
];
const SUB_FALLBACKS: Record<string, string> = {
  "/stander/livestream/0/0": "/stander/livestream/0/1",
  "/user=admin&password={PW}&channel=1&stream=0.sdp?": "/user=admin&password={PW}&channel=1&stream=1.sdp?",
  "/cam/realmonitor?channel=1&subtype=0": "/cam/realmonitor?channel=1&subtype=1",
  "/Streaming/Channels/101": "/Streaming/Channels/102",
  "/stream1": "/stream2",
};

export function loadPasswords(): string[] {
  let text = "";
  try { text = readFileSync(resolve(import.meta.dir, "../../../../.env"), "utf8"); } catch {}
  if (!text) { try { text = readFileSync(resolve(import.meta.dir, "../../../.env"), "utf8"); } catch {} }
  const pws: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*CAM_PASSWORD_\d+\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1]!.trim()) pws.push(m[1]!.trim().replace(/^["']|["']$/g, ""));
  }
  return [...new Set(pws)];
}

type AuthMode = "digest" | "text";
function wsSec(user: string, pass: string, offsetMs = 0, mode: AuthMode = "digest") {
  const created = new Date(Date.now() + offsetMs).toISOString();
  if (mode === "text") {
    return `<wsse:Security s:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${user}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${pass}</wsse:Password></wsse:UsernameToken></wsse:Security>`;
  }
  const nonce = randomBytes(16);
  const digest = createHash("sha1").update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(pass)])).digest("base64");
  return `<wsse:Security s:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${user}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
}
async function soap(url: string, body: string, sec = ""): Promise<{ status: number; text: string }> {
  try {
    const envlp = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Header>${sec}</s:Header><s:Body>${body}</s:Body></s:Envelope>`;
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/soap+xml; charset=utf-8" }, body: envlp, signal: AbortSignal.timeout(5000) });
    return { status: r.status, text: await r.text() };
  } catch { return { status: 0, text: "" }; }
}
function parseClockOffset(xml: string): number {
  const utc = /<tt:UTCDateTime>([\s\S]*?)<\/tt:UTCDateTime>/.exec(xml)?.[1] ?? xml;
  const g = (t: string) => Number(new RegExp(`<tt:${t}>(\\d+)</tt:${t}>`).exec(utc)?.[1]);
  const [y, mo, d, h, mi, s] = [g("Year"), g("Month"), g("Day"), g("Hour"), g("Minute"), g("Second")];
  if (!y || !mo || !d) return 0;
  return Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0) - Date.now();
}
const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x2f;/gi, "/").replace(/&#38;/g, "&");
const enc = encodeURIComponent;

interface OnvifEndpoint { port: number; secure: boolean; base: string; offsetMs: number; }
async function findOnvifPort(host: string): Promise<OnvifEndpoint | null> {
  for (const port of [...new Set(ONVIF_PORTS)]) {
    if (!(await tcpProbe(host, port, 800))) continue;
    const secure = port === 443 || port === 8443;
    const base = `${secure ? "https" : "http"}://${host}:${port}`;
    const r = await soap(`${base}/onvif/device_service`, `<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>`);
    if (r.status === 200 && r.text.includes("SystemDateAndTime")) return { port, secure, base, offsetMs: parseClockOffset(r.text) };
  }
  return null;
}
async function resolveMediaUrl(ep: OnvifEndpoint, host: string, sec: string): Promise<string> {
  const def = `${ep.base}/onvif/media_service`;
  const caps = await soap(`${ep.base}/onvif/device_service`, `<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>Media</Category></GetCapabilities>`, sec);
  const xaddr = [...caps.text.matchAll(/XAddr>([^<]+)/g)].map((m) => decodeEntities(m[1]!)).find((u) => /media/i.test(u));
  if (!xaddr) return def;
  try { const u = new URL(xaddr); u.hostname = host; return u.toString(); } catch { return def; }
}
async function getStreamUris(host: string, ep: OnvifEndpoint, pw: string): Promise<{ main: string; sub?: string } | null> {
  const variants: Array<{ offset: number; mode: AuthMode }> = [
    { offset: ep.offsetMs, mode: "digest" }, { offset: ep.offsetMs, mode: "text" }, { offset: 0, mode: "digest" },
  ];
  for (const v of variants) {
    const sec = () => wsSec("admin", pw, v.offset, v.mode);
    const media = await resolveMediaUrl(ep, host, sec());
    const gp = await soap(media, `<trt:GetProfiles/>`, sec());
    if (gp.status !== 200) continue;
    const tokens = [...gp.text.matchAll(/<[^>]*Profiles[^>]*token="([^"]+)"/g)].map((m) => m[1]!);
    if (!tokens.length) continue;
    const uriFor = async (tk: string) => {
      const su = await soap(media, `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${tk}</trt:ProfileToken></trt:GetStreamUri>`, sec());
      const raw = /<[^>]*:Uri>([^<]+)<\/[^>]*:Uri>|<Uri>([^<]+)<\/Uri>/.exec(su.text)?.slice(1).find(Boolean);
      return raw ? decodeEntities(raw) : null;
    };
    const main = await uriFor(tokens[0]!);
    if (!main) continue;
    const sub = tokens[1] ? await uriFor(tokens[1]!) : undefined;
    return { main, sub: sub ?? undefined };
  }
  return null;
}
async function rtspYieldsFrame(rtspUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${env.go2rtcUrl}/api/frame.jpeg?src=ffmpeg:${enc(rtspUrl)}`, { signal: AbortSignal.timeout(18000) });
    if (!r.ok) return false;
    return (await r.arrayBuffer()).byteLength > 2000;
  } catch { return false; }
}
function rtspAuthority(host: string, port: number, user: string, pw: string, path: string) {
  return `rtsp://${enc(user)}:${enc(pw)}@${host}:${port}${path.replace("{PW}", enc(pw))}`;
}

export interface Found { protocol: "RTSP"; host: string; rtspPort: number; httpPort: number; main: string; sub: string; pwIndex: number; via: string; }

async function isapiAuthOk(host: string, port: number, pw: string): Promise<boolean> {
  const url = `http://${host}:${port}/ISAPI/System/deviceInfo`;
  try { const basic = await fetch(url, { headers: { Authorization: "Basic " + Buffer.from(`admin:${pw}`).toString("base64") }, signal: AbortSignal.timeout(5000) }); if (basic.status === 200) return true; } catch {}
  try { const dig = await digestFetch(url, "admin", pw, { method: "GET" }); if (dig.status === 200) return true; } catch {}
  return false;
}
async function tryHikvision(host: string, httpPortHint: number, pws: string[]): Promise<Found | null> {
  const ports = [...new Set([80, httpPortHint].filter((p) => p && p > 0))];
  for (const port of ports) {
    if (!(await tcpProbe(host, port, 800))) continue;
    for (let i = 0; i < pws.length; i++) {
      if (await isapiAuthOk(host, port, pws[i]!)) {
        return { protocol: "RTSP", host, rtspPort: 554, httpPort: port, main: "/Streaming/Channels/101", sub: "/Streaming/Channels/102", pwIndex: i, via: `isapi:${port}` };
      }
    }
  }
  return null;
}

/** Finds a working stream config for a host. opts.onvifOnly skips the slow RTSP path probing. */
export async function discover(host: string, httpPortHint: number, pws: string[], opts: { onvifOnly?: boolean } = {}): Promise<Found | null> {
  const hik = await tryHikvision(host, httpPortHint, pws);
  if (hik) return hik;
  const onvif = await findOnvifPort(host);
  if (onvif) {
    for (let i = 0; i < pws.length; i++) {
      const uris = await getStreamUris(host, onvif, pws[i]!);
      if (uris) {
        const u = new URL(uris.main);
        const rtspPort = Number(u.port) || 554;
        const mainPath = u.pathname + u.search;
        let subPath = mainPath;
        if (uris.sub) { try { const su = new URL(uris.sub); subPath = su.pathname + su.search; } catch {} }
        const subOk = subPath === mainPath || (await rtspYieldsFrame(rtspAuthority(host, rtspPort, "admin", pws[i]!, subPath)));
        return { protocol: "RTSP", host, rtspPort, httpPort: onvif.port, main: mainPath, sub: subOk ? subPath : mainPath, pwIndex: i, via: `onvif:${onvif.port}` };
      }
    }
  }
  if (opts.onvifOnly) return null;
  if (!(await tcpProbe(host, 554, 800))) return null;
  for (let i = 0; i < pws.length; i++) {
    for (const path of RTSP_FALLBACKS) {
      if (await rtspYieldsFrame(rtspAuthority(host, 554, "admin", pws[i]!, path))) {
        const subTpl = SUB_FALLBACKS[path];
        let sub = path;
        if (subTpl && (await rtspYieldsFrame(rtspAuthority(host, 554, "admin", pws[i]!, subTpl)))) sub = subTpl;
        return { protocol: "RTSP", host, rtspPort: 554, httpPort: httpPortHint, main: path, sub, pwIndex: i, via: "rtsp-probe" };
      }
    }
  }
  return null;
}

/** Discover one camera by id and, on success, persist the config and re-sync its go2rtc stream. */
export async function applyDiscovery(cameraId: number, opts: { onvifOnly?: boolean; pws?: string[] } = {}): Promise<{ ok: boolean; via?: string }> {
  const cam = await prisma.camera.findUnique({ where: { id: cameraId } });
  if (!cam?.host) return { ok: false };
  const pws = opts.pws ?? loadPasswords();
  if (!pws.length) return { ok: false };
  const res = await discover(cam.host, cam.httpPort ?? 80, pws, opts);
  if (!res) return { ok: false };
  await prisma.camera.update({
    where: { id: cameraId },
    data: { protocol: "RTSP", rtspPort: res.rtspPort, httpPort: res.httpPort, mainStreamPath: res.main, subStreamPath: res.sub, username: "admin", passwordEnc: await encryptSecret(pws[res.pwIndex]!), status: "ONLINE", lastSeenAt: new Date(), importFlags: null },
  });
  await syncCamera(cameraId).catch(() => {});
  return { ok: true, via: res.via };
}
