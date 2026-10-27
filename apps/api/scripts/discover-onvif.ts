/**
 * Discovers how to stream an ONVIF/OEM camera when the registry protocol/port is wrong.
 * For one host (--host) or every failing ONVIF/Belko/UNKNOWN camera (default), it:
 *   1. finds the ONVIF service port (tries 2020, 8899, 8080, 80, 443, 85, 8000)
 *   2. authenticates with each configured password (WS-Security PasswordDigest)
 *   3. reads the real RTSP URI via GetProfiles + GetStreamUri
 *   4. falls back to probing common OEM RTSP paths directly through go2rtc
 *   5. with --apply, saves protocol=RTSP + paths + password and re-syncs the stream
 *
 *   bun run scripts/discover-onvif.ts --host 192.168.20.183 [--apply]
 *   bun run scripts/discover-onvif.ts [--apply] [--limit N] [--concurrency N]
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/lib/prisma.ts";
import { encryptSecret } from "../src/lib/crypto.ts";
import { env } from "../src/lib/env.ts";
import { syncCamera } from "../src/services/go2rtc.ts";
import { tcpProbe } from "../src/services/health.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onvifOnly = args.includes("--onvif-only");
const hostArg = args[args.indexOf("--host") + 1];
const singleHost = args.includes("--host") ? hostArg : null;
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const concurrency = args.includes("--concurrency") ? Number(args[args.indexOf("--concurrency") + 1]) : 6;

// 8080 = Sofia/gSOAP family, 2020 = Hikvision-OEM family, then the rest. 9060 is open on Sofia
// cams but is NOT the ONVIF service (it stalls), so it is intentionally excluded.
const ONVIF_PORTS = [8080, 2020, 80, 8899, 443, 85, 8000, 5000];
const RTSP_FALLBACKS = [
  "/user=admin&password={PW}&channel=1&stream=0.sdp?",
  "/cam/realmonitor?channel=1&subtype=0",
  "/live/ch0", "/live/ch00_0", "/live/main", "/11", "/0", "/1",
  "/h264/ch1/main/av_stream", "/stream1", "/Streaming/Channels/101",
];
const SUB_FALLBACKS: Record<string, string> = {
  "/user=admin&password={PW}&channel=1&stream=0.sdp?": "/user=admin&password={PW}&channel=1&stream=1.sdp?",
  "/cam/realmonitor?channel=1&subtype=0": "/cam/realmonitor?channel=1&subtype=1",
  "/Streaming/Channels/101": "/Streaming/Channels/102",
  "/stream1": "/stream2",
};

function loadPasswords(): string[] {
  const text = readFileSync(resolve(import.meta.dir, "../../../.env"), "utf8");
  const pws: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*CAM_PASSWORD_\d+\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1]!.trim()) pws.push(m[1]!.trim().replace(/^["']|["']$/g, ""));
  }
  return [...new Set(pws)];
}

function wsSec(user: string, pass: string) {
  const created = new Date().toISOString();
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

async function findOnvifPort(host: string): Promise<{ port: number; secure: boolean } | null> {
  for (const port of [...new Set(ONVIF_PORTS)]) {
    // Skip closed ports instantly so cameras without ONVIF don't cost 7 SOAP timeouts.
    if (!(await tcpProbe(host, port, 800))) continue;
    const secure = port === 443 || port === 8443;
    const url = `${secure ? "https" : "http"}://${host}:${port}/onvif/device_service`;
    const r = await soap(url, `<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>`);
    if (r.status === 200 && r.text.includes("SystemDateAndTime")) return { port, secure };
  }
  return null;
}

async function getStreamUris(host: string, port: number, secure: boolean, pw: string): Promise<{ main: string; sub?: string } | null> {
  const media = `${secure ? "https" : "http"}://${host}:${port}/onvif/media_service`;
  const gp = await soap(media, `<trt:GetProfiles/>`, wsSec("admin", pw));
  if (gp.status !== 200) return null;
  const tokens = [...gp.text.matchAll(/<[^>]*Profiles[^>]*token="([^"]+)"/g)].map((m) => m[1]!);
  if (!tokens.length) return null;
  // Prefixed trt:/tt: namespaces are required by gSOAP/Sofia cameras (they 400 on the
  // default-namespace form that Hikvision-ONVIF accepts).
  const uriFor = async (tk: string) => {
    const su = await soap(media, `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${tk}</trt:ProfileToken></trt:GetStreamUri>`, wsSec("admin", pw));
    const raw = /<[^>]*:Uri>([^<]+)<\/[^>]*:Uri>|<Uri>([^<]+)<\/Uri>/.exec(su.text)?.slice(1).find(Boolean);
    return raw ? decodeEntities(raw) : null;
  };
  const main = await uriFor(tokens[0]!);
  if (!main) return null;
  const sub = tokens[1] ? await uriFor(tokens[1]!) : undefined;
  return { main, sub: sub ?? undefined };
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x2f;/gi, "/").replace(/&#38;/g, "&");
const enc = encodeURIComponent;
/** Pulls a single frame through go2rtc's ffmpeg to prove an RTSP URL actually yields media. */
async function rtspYieldsFrame(rtspUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${env.go2rtcUrl}/api/frame.jpeg?src=ffmpeg:${enc(rtspUrl)}`, { signal: AbortSignal.timeout(18000) });
    if (!r.ok) return false;
    const buf = await r.arrayBuffer();
    return buf.byteLength > 2000;
  } catch { return false; }
}

function rtspAuthority(host: string, port: number, user: string, pw: string, path: string) {
  return `rtsp://${enc(user)}:${enc(pw)}@${host}:${port}${path.replace("{PW}", enc(pw))}`;
}

interface Found { protocol: "RTSP"; host: string; rtspPort: number; httpPort: number; main: string; sub: string; pwIndex: number; via: string; }

async function discover(host: string, httpPortHint: number, pws: string[]): Promise<Found | null> {
  // 1) ONVIF discovery (preferred — exact URLs straight from the device)
  const onvif = await findOnvifPort(host);
  if (onvif) {
    for (let i = 0; i < pws.length; i++) {
      const uris = await getStreamUris(host, onvif.port, onvif.secure, pws[i]!);
      if (uris) {
        const u = new URL(uris.main);
        const rtspPort = Number(u.port) || 554;
        const mainPath = u.pathname + u.search;
        let subPath = mainPath;
        if (uris.sub) { try { const su = new URL(uris.sub); subPath = su.pathname + su.search; } catch {} }
        // verify sub actually streams; fall back to main if not
        const subOk = subPath === mainPath || (await rtspYieldsFrame(rtspAuthority(host, rtspPort, "admin", pws[i]!, subPath)));
        return { protocol: "RTSP", host, rtspPort, httpPort: onvif.port, main: mainPath, sub: subOk ? subPath : mainPath, pwIndex: i, via: `onvif:${onvif.port}` };
      }
    }
  }
  // 2) Direct RTSP path probing (for OEM cams with ONVIF disabled, e.g. Sofia/XMeye on 34567)
  if (onvifOnly) return null;
  if (!(await tcpProbe(host, 554, 800))) return null;
  for (let i = 0; i < pws.length; i++) {
    for (const path of RTSP_FALLBACKS) {
      const url = rtspAuthority(host, 554, "admin", pws[i]!, path);
      if (await rtspYieldsFrame(url)) {
        const subTpl = SUB_FALLBACKS[path];
        let sub = path;
        if (subTpl && (await rtspYieldsFrame(rtspAuthority(host, 554, "admin", pws[i]!, subTpl)))) sub = subTpl;
        return { protocol: "RTSP", host, rtspPort: 554, httpPort: httpPortHint, main: path, sub, pwIndex: i, via: "rtsp-probe" };
      }
    }
  }
  return null;
}

async function runPool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

async function main() {
  const pws = loadPasswords();
  if (!pws.length) { console.error("no CAM_PASSWORD_* in .env"); process.exit(2); }

  let cams;
  if (singleHost) {
    cams = await prisma.camera.findMany({ where: { host: singleHost } });
    if (!cams.length) { console.log(`no camera with host ${singleHost}; probing host directly`); }
  } else {
    // Every ONVIF camera (the port-80 discovery failures) plus RTSP cameras not yet configured
    // with a path. Discovery only writes when it gets a verified stream, so already-working
    // cameras are left untouched on a miss.
    const where = args.includes("--all")
      ? { isEnabled: true, host: { not: null }, protocol: { in: ["ONVIF", "RTSP"] } }
      : { isEnabled: true, host: { not: null }, OR: [{ protocol: "ONVIF" }, { protocol: "RTSP", mainStreamPath: null }] };
    cams = await prisma.camera.findMany({ where, orderBy: { id: "asc" }, take: Number.isFinite(limit) ? limit : undefined });
  }

  const targets = singleHost && !cams.length ? [{ id: 0, deviceNo: "(probe)", host: singleHost, httpPort: 80 } as any] : cams;
  console.log(`[discover] ${targets.length} target(s); apply=${apply}; passwords=${pws.length}`);
  const found: string[] = [], miss: string[] = [];

  await runPool(targets, singleHost ? 1 : concurrency, async (cam) => {
    const res = await discover(cam.host!, cam.httpPort ?? 80, pws);
    if (!res) { miss.push(cam.deviceNo); console.log(`  ✗ ${cam.deviceNo} (${cam.host}) — no ONVIF port and no known RTSP path`); return; }
    const mainMasked = res.main.replace(/password=[^&]*/i, "password=***");
    console.log(`  ✓ ${cam.deviceNo} (${cam.host}) via ${res.via}: main=${mainMasked} sub=${res.sub === res.main ? "(=main)" : res.sub.replace(/password=[^&]*/i, "password=***")} pw#${res.pwIndex + 1} rtspPort=${res.rtspPort}`);
    found.push(cam.deviceNo);
    if (apply && cam.id) {
      await prisma.camera.update({ where: { id: cam.id }, data: { protocol: "RTSP", rtspPort: res.rtspPort, httpPort: res.httpPort, mainStreamPath: res.main, subStreamPath: res.sub, username: "admin", passwordEnc: await encryptSecret(pws[res.pwIndex]!), status: "ONLINE", lastSeenAt: new Date(), importFlags: null } });
      await syncCamera(cam.id).catch(() => {});
    }
  });

  console.log(`[discover] done. found: ${found.length}, missed: ${miss.length}${apply ? " (applied)" : " (dry run — add --apply to save)"}`);
  if (miss.length) console.log(`[discover] missed: ${miss.slice(0, 40).join(", ")}${miss.length > 40 ? " …" : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
