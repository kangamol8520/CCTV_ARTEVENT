/**
 * Finds which admin password each camera / NVR actually uses, and stores it (encrypted).
 *
 *   bun run scripts/apply-credentials.ts [--nvrs] [--cameras] [--only-failing] [--dry-run] [--concurrency N]
 *
 * Passwords come from the project-root .env (CAM_PASSWORD_1..N). Username is forced to "admin".
 * Nothing is printed except the password INDEX that matched (never the value).
 *
 * Detection method per device:
 *   - Hikvision / HiLook  -> ISAPI digest GET /ISAPI/System/deviceInfo (fast, definitive)
 *   - ONVIF / RTSP        -> go2rtc temporary stream, wait for real media (covers path discovery)
 *   - NVR (any brand)     -> ISAPI digest for Hikvision, else go2rtc channel-1 RTSP probe
 * NVR_CHANNEL cameras are skipped: they authenticate through their NVR, so fixing the NVR fixes them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/lib/prisma.ts";
import { encryptSecret } from "../src/lib/crypto.ts";
import { digestFetch } from "../src/services/hikvision.ts";
import { env } from "../src/lib/env.ts";
import { syncCamera, putStream, deleteStream } from "../src/services/go2rtc.ts";

const USERNAME = "admin";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyFailing = args.includes("--only-failing");
const doNvrs = args.includes("--nvrs") || !args.includes("--cameras");
const doCams = args.includes("--cameras") || !args.includes("--nvrs");
const concurrency = Number(args[args.indexOf("--concurrency") + 1]) || 8;

// ---- load passwords from root .env (not committed) --------------------------
function loadPasswords(): string[] {
  const path = resolve(import.meta.dir, "../../../.env");
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { throw new Error(`Cannot read ${path}`); }
  const pws: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*CAM_PASSWORD_\d+\s*=\s*(.*)\s*$/.exec(line);
    if (m) {
      let v = m[1]!.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v) pws.push(v);
    }
  }
  return [...new Set(pws)];
}

const rtspProbeHik = async (host: string, httpPort: number, pw: string): Promise<boolean> => {
  try {
    const res = await digestFetch(`http://${host}:${httpPort}/ISAPI/System/deviceInfo`, USERNAME, pw, { method: "GET" });
    return res.status === 200;
  } catch { return false; }
};

/** Builds a go2rtc source for a trial password and waits until real media arrives. */
async function go2rtcProbe(name: string, src: string, waitMs = 9000): Promise<boolean> {
  try {
    await putStream(name, src);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await Bun.sleep(1000);
      const res = await fetch(`${env.go2rtcUrl}/api/streams?src=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const info = (await res.json()) as { producers?: { medias?: string[]; error?: string }[] };
        for (const p of info.producers ?? []) {
          if (p.medias && p.medias.length) return true;
        }
      }
    }
    return false;
  } catch { return false; } finally { await deleteStream(name).catch(() => {}); }
}

const enc = (s: string) => encodeURIComponent(s);

function camSource(cam: { protocol: string; host: string; rtspPort: number; httpPort: number; mainStreamPath: string | null }, pw: string): string | null {
  const auth = `${enc(USERNAME)}:${enc(pw)}@`;
  if (cam.protocol === "ONVIF") return `onvif://${auth}${cam.host}:${cam.httpPort}?subtype=1`;
  if (cam.protocol === "HIKVISION") return `rtsp://${auth}${cam.host}:${cam.rtspPort}/Streaming/Channels/102`;
  if (cam.protocol === "RTSP" && cam.mainStreamPath) return `rtsp://${auth}${cam.host}:${cam.rtspPort}${cam.mainStreamPath}`;
  return null;
}

async function detectCamera(cam: any, pws: string[]): Promise<number | null> {
  const isHik = cam.protocol === "HIKVISION" || cam.brand === "HIKVISION" || cam.brand === "HILOOK";
  for (let i = 0; i < pws.length; i++) {
    const pw = pws[i]!;
    let ok = false;
    if (isHik && cam.host) ok = await rtspProbeHik(cam.host, cam.httpPort, pw);
    if (!ok && cam.host) {
      const src = camSource(cam, pw);
      if (src) ok = await go2rtcProbe(`probe-cam-${cam.id}`, src);
    }
    if (ok) return i;
  }
  return null;
}

/** Returns {idx, httpPort} on success — httpPort may be corrected to 80 when the stored
 *  forwarded port is not reachable on the LAN. */
async function detectNvr(nvr: any, pws: string[]): Promise<{ idx: number; httpPort: number } | null> {
  const isHik = nvr.brand === "HIKVISION";
  const httpPorts = nvr.httpPort === 80 ? [80] : [nvr.httpPort, 80];
  for (let i = 0; i < pws.length; i++) {
    const pw = pws[i]!;
    if (isHik) {
      for (const port of httpPorts) {
        if (await rtspProbeHik(nvr.host, port, pw)) return { idx: i, httpPort: port };
      }
    }
    const path = nvr.channelMainPath.replace("{ch}", "1");
    const src = `rtsp://${enc(USERNAME)}:${enc(pw)}@${nvr.host}:${nvr.rtspPort}${path}`;
    if (await go2rtcProbe(`probe-nvr-${nvr.id}`, src)) return { idx: i, httpPort: nvr.httpPort };
  }
  return null;
}

async function runPool<T>(items: T[], n: number, fn: (x: T, idx: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]!, k); }
  }));
}

async function main() {
  const pws = loadPasswords();
  if (!pws.length) {
    console.error("ยังไม่มีรหัสผ่านใน .env (CAM_PASSWORD_1..3) — ใส่ค่าก่อนแล้วรันใหม่");
    process.exit(2);
  }
  console.log(`[apply] loaded ${pws.length} distinct password(s); username=${USERNAME}; dryRun=${dryRun}, onlyFailing=${onlyFailing}`);

  const matched: Record<string, number> = {};
  const bump = (i: number) => (matched[`#${i + 1}`] = (matched[`#${i + 1}`] ?? 0) + 1);

  if (doNvrs) {
    const nvrs = await prisma.nvr.findMany();
    const targets = onlyFailing ? nvrs.filter((n) => n.status !== "ONLINE") : nvrs;
    console.log(`[apply] NVRs to test: ${targets.length}`);
    let done = 0;
    const failed: string[] = [];
    const portFixed: string[] = [];
    await runPool(targets, concurrency, async (nvr) => {
      const hit = await detectNvr(nvr, pws);
      done++;
      if (hit === null) { failed.push(nvr.name); return; }
      bump(hit.idx);
      const data: Record<string, unknown> = { username: USERNAME, passwordEnc: await encryptSecret(pws[hit.idx]!) };
      if (hit.httpPort !== nvr.httpPort) { data.httpPort = hit.httpPort; portFixed.push(`${nvr.name}:${nvr.httpPort}->${hit.httpPort}`); }
      if (!dryRun) await prisma.nvr.update({ where: { id: nvr.id }, data });
      if (done % 5 === 0) console.log(`  …NVR ${done}/${targets.length}`);
    });
    if (portFixed.length) console.log(`[apply] NVR httpPort corrected to LAN port: ${portFixed.join(", ")}`);
    console.log(`[apply] NVR done. matched by password: ${JSON.stringify(matched)}; failed ${failed.length}: ${failed.slice(0, 20).join(", ")}`);
  }

  if (doCams) {
    const cams = await prisma.camera.findMany({ where: { isEnabled: true, protocol: { not: "NVR_CHANNEL" }, host: { not: null } } });
    const targets = onlyFailing ? cams.filter((c) => c.status !== "ONLINE") : cams;
    console.log(`[apply] cameras to test: ${targets.length}`);
    const camMatched: Record<string, number> = {};
    const bumpC = (i: number) => (camMatched[`#${i + 1}`] = (camMatched[`#${i + 1}`] ?? 0) + 1);
    let done = 0;
    const failed: string[] = [];
    const fixed: number[] = [];
    await runPool(targets, concurrency, async (cam) => {
      const idx = await detectCamera(cam, pws);
      done++;
      if (idx === null) { failed.push(cam.deviceNo); if (done % 20 === 0) console.log(`  …cam ${done}/${targets.length}`); return; }
      bumpC(idx);
      fixed.push(cam.id);
      if (!dryRun) {
        await prisma.camera.update({ where: { id: cam.id }, data: { username: USERNAME, passwordEnc: await encryptSecret(pws[idx]!) } });
        await syncCamera(cam.id).catch(() => {});
      }
      if (done % 20 === 0) console.log(`  …cam ${done}/${targets.length}`);
    });
    console.log(`[apply] cameras done. matched by password: ${JSON.stringify(camMatched)}`);
    console.log(`[apply] cameras fixed: ${fixed.length}; still failing: ${failed.length}`);
    if (failed.length) console.log(`[apply] still failing (ตรวจ IP/โปรโตคอล/พอร์ต): ${failed.slice(0, 40).join(", ")}${failed.length > 40 ? " …" : ""}`);
  }

  console.log("[apply] done." + (dryRun ? " (dry run — ไม่ได้บันทึก)" : " บันทึกและ sync go2rtc แล้ว"));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
