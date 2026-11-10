/**
 * Applies the operator-filled registry Excel: plug&play camera -> NVR + channel, and NVR ports.
 *
 *   bun run scripts/apply-plugplay.ts <file.xlsx> [--apply]
 *
 * Without --apply it only prints what would change. Columns used:
 *   NVR rows (CCTV_Type N): IPv4_1 (host, ":port" suffix stripped), HTTP, RTSP Port
 *   plug&play cameras (IPv4_1 contains "plug"): NVR (NVR IP), ช่อง NVR (channel on that NVR)
 * Each port is TCP-probed first; a closed port is not applied (keeps the current one).
 * Channels are cross-checked against the channel names on the NVR (ISAPI InputProxy): if the
 * NVR names another channel after this camera, that channel wins; leftover duplicates on one
 * channel are cleared and flagged CHANNEL_CONFLICT. Each assigned channel is then test-streamed.
 */
import * as XLSX from "xlsx";
import { prisma } from "../src/lib/prisma.ts";
import { decryptSecret } from "../src/lib/crypto.ts";
import { digestFetch } from "../src/services/hikvision.ts";
import { tcpProbe } from "../src/services/health.ts";
import { env } from "../src/lib/env.ts";
import { syncCamera, putStream, deleteStream } from "../src/services/go2rtc.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
if (!file) { console.error("usage: bun run scripts/apply-plugplay.ts <file.xlsx> [--apply]"); process.exit(1); }

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const int = (v: unknown) => { const n = Number(s(v)); return Number.isInteger(n) && n > 0 ? n : null; };
const hostOf = (v: unknown) => { const h = s(v).split(":")[0]!.replace(/\s+/g, ""); return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? h : null; };

/** True when an NVR channel name refers to this DeviceNo ("OD1-32" also matches "OD-32-OUTSIDE4"). */
function nameMatches(name: string, deviceNo: string): boolean {
  const dev = deviceNo.toUpperCase();
  const variant = dev.replace(/^([A-Z]+)\d-/, "$1-");
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9])(${esc(dev)}|${esc(variant)})(?!\\d)`).test(name.toUpperCase());
}

async function channelNames(nvr: { host: string; httpPort: number; username: string | null; passwordEnc: string | null }): Promise<Map<number, string> | null> {
  try {
    const pw = (await decryptSecret(nvr.passwordEnc)) ?? "";
    const res = await digestFetch(`http://${nvr.host}:${nvr.httpPort}/ISAPI/ContentMgmt/InputProxy/channels`, nvr.username ?? "admin", pw);
    if (res.status !== 200) return null;
    const xml = await res.text();
    const out = new Map<number, string>();
    for (const b of xml.split("<InputProxyChannel ").slice(1)) {
      const id = Number(/<id>(\d+)<\/id>/.exec(b)?.[1]);
      if (id) out.set(id, /<name>([^<]*)<\/name>/.exec(b)?.[1] ?? "");
    }
    return out;
  } catch { return null; }
}

/** Registers a temporary go2rtc stream and pulls one keyframe (go2rtc only dials on demand). */
async function streams(name: string, src: string, waitMs = 12000): Promise<boolean> {
  try {
    await putStream(name, src);
    const res = await fetch(`${env.go2rtcUrl}/api/frame.mp4?src=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(waitMs) });
    return res.ok && (await res.arrayBuffer()).byteLength > 1000;
  } catch { return false; } finally { await deleteStream(name).catch(() => {}); }
}

async function main() {
  const wb = XLSX.readFile(file!);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]!]!, { defval: null });
  console.log(`[plugplay] ${file} — ${rows.length} rows, mode=${apply ? "APPLY" : "dry-run"}`);

  // ---- NVR ports -------------------------------------------------------------------------
  const nvrs = await prisma.nvr.findMany();
  for (const row of rows.filter((r) => s(r.CCTV_Type) === "N")) {
    const nvr = nvrs.find((n) => n.legacyDeviceNo === s(row.DeviceNo));
    const host = hostOf(row.IPv4_1);
    if (!nvr || !host) { console.log(`  NVR ${s(row.DeviceNo)}: not in DB / no IP — skipped`); continue; }
    const data: { host?: string; httpPort?: number; rtspPort?: number } = {};
    const notes: string[] = [];
    if (host !== nvr.host) data.host = host;
    for (const [col, key, cur] of [["HTTP", "httpPort", nvr.httpPort], ["RTSP Port", "rtspPort", nvr.rtspPort]] as const) {
      const want = int(row[col]);
      if (!want || want === cur) continue;
      if (await tcpProbe(host, want)) data[key] = want;
      else notes.push(`${col} ${want} ปิดอยู่ — คงค่า ${cur}`);
    }
    if (Object.keys(data).length || notes.length) console.log(`  NVR ${nvr.legacyDeviceNo} ${nvr.name}: ${JSON.stringify(data)} ${notes.join("; ")}`);
    if (apply && Object.keys(data).length) Object.assign(nvr, await prisma.nvr.update({ where: { id: nvr.id }, data }));
  }

  // ---- plug&play cameras -> NVR + channel ------------------------------------------------
  type Plan = { camId: number; deviceNo: string; nvrId: number | null; nvrHost: string; channel: number | null; note: string[] };
  const plans: Plan[] = [];
  const names = new Map<number, Map<number, string> | null>();
  for (const row of rows.filter((r) => s(r.CCTV_Type) !== "N" && /plug/i.test(s(r.IPv4_1)))) {
    const deviceNo = s(row.DeviceNo);
    const cam = await prisma.camera.findUnique({ where: { deviceNo } });
    if (!cam) { console.log(`  ${deviceNo}: not in DB — skipped`); continue; }
    const nvrHost = hostOf(row.NVR) ?? "";
    const nvr = nvrs.find((n) => n.host === nvrHost) ?? null;
    const plan: Plan = { camId: cam.id, deviceNo, nvrId: nvr?.id ?? null, nvrHost, channel: int(row["ช่อง NVR"]), note: [] };
    if (!nvr) plan.note.push(`ไม่พบ NVR ${s(row.NVR)}`);
    if (nvr && !names.has(nvr.id)) names.set(nvr.id, await channelNames(nvr));
    const chNames = nvr ? names.get(nvr.id) : null;
    if (chNames) {
      const named = [...chNames].filter(([, n]) => nameMatches(n, deviceNo)).map(([id]) => id);
      if (plan.channel && !named.includes(plan.channel) && named.length === 1) {
        plan.note.push(`Excel ช่อง ${plan.channel} ("${chNames.get(plan.channel) ?? "-"}") → ใช้ช่อง ${named[0]} ตามชื่อบน NVR`);
        plan.channel = named[0]!;
      } else if (plan.channel && !named.includes(plan.channel)) {
        plan.note.push(`ชื่อช่องบน NVR = "${chNames.get(plan.channel) ?? "ไม่มีช่องนี้"}"`);
      }
    } else if (nvr) plan.note.push("อ่านชื่อช่องจาก NVR ไม่ได้ (รหัส NVR?)");
    if (!plan.channel) plan.note.push(s(row.Remark) || "ไม่มีเลขช่อง");
    plans.push(plan);
  }
  // Two cameras on one channel: the one the NVR names keeps it, the rest are cleared.
  const byCh = new Map<string, Plan[]>();
  for (const p of plans) if (p.nvrId && p.channel) byCh.set(`${p.nvrId}:${p.channel}`, [...(byCh.get(`${p.nvrId}:${p.channel}`) ?? []), p]);
  for (const group of byCh.values()) {
    if (group.length < 2) continue;
    const chName = names.get(group[0]!.nvrId!)?.get(group[0]!.channel!) ?? "";
    const owner = group.find((p) => nameMatches(chName, p.deviceNo));
    for (const p of group) {
      if (p === owner) continue;
      p.note.push(`ช่อง ${p.channel} ซ้ำกับ ${group.filter((g) => g !== p).map((g) => g.deviceNo).join(",")} — ล้างค่ารอตรวจ`);
      p.channel = null;
    }
  }

  let okCount = 0;
  for (const p of plans) {
    const nvr = nvrs.find((n) => n.id === p.nvrId);
    let live = "";
    if (nvr && p.channel) {
      const pw = (await decryptSecret(nvr.passwordEnc)) ?? "";
      const path = nvr.channelSubPath.replace("{ch}", String(p.channel));
      const ok = await streams(`probe-pnp-${p.camId}`, `rtsp://${encodeURIComponent(nvr.username ?? "admin")}:${encodeURIComponent(pw)}@${nvr.host}:${nvr.rtspPort}${path}`);
      live = ok ? "ขึ้นภาพ" : "ไม่ขึ้นภาพ";
      if (ok) okCount++;
    }
    console.log(`  ${p.deviceNo.padEnd(7)} NVR ${p.nvrHost.padEnd(15)} ch ${String(p.channel ?? "-").padEnd(3)} ${live.padEnd(10)} ${p.note.join("; ")}`);
    if (!apply) continue;
    await prisma.camera.update({
      where: { id: p.camId },
      data: {
        protocol: "NVR_CHANNEL", host: null, nvrId: p.nvrId, nvrChannel: p.channel,
        importFlags: p.channel ? null : p.note.some((n) => n.includes("ซ้ำ")) ? "CHANNEL_CONFLICT" : "PLUGANDPLAY_NEEDS_CHANNEL",
        status: live === "ขึ้นภาพ" ? "ONLINE" : undefined, lastSeenAt: live === "ขึ้นภาพ" ? new Date() : undefined,
      },
    });
    await syncCamera(p.camId).catch(() => {});
  }
  console.log(`[plugplay] cameras: ${plans.length}, with channel: ${plans.filter((p) => p.channel).length}, streaming: ${okCount}${apply ? "" : " (dry-run — nothing written)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
