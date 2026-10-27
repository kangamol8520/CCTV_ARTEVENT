/**
 * Imports the legacy camera registry (Excel) into the database.
 *
 *   bun run scripts/import-registry.ts [path/to/registry.xlsx] [--dry-run]
 *
 * Idempotent: rows are upserted by DeviceNo (cameras) / name (NVRs). Rows the script cannot map
 * are imported anyway with importFlags set, so they can be fixed in the UI.
 */
import * as XLSX from "xlsx";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/lib/prisma.ts";
import { encryptSecret } from "../src/lib/crypto.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileArg = args.find((a) => !a.startsWith("--"));
const registryDir = resolve(import.meta.dir, "../../../registry");
const file = fileArg ?? (() => {
  const xlsx = readdirSync(registryDir).filter((f) => f.endsWith(".xlsx") && !f.startsWith("~$"));
  if (!xlsx.length) throw new Error(`No .xlsx found in ${registryDir}`);
  return resolve(registryDir, xlsx[0]!);
})();

interface Row {
  ID?: number; DeviceNo?: string; FloorCode?: string; RoomCode?: string; RoomName?: string; Desciption?: string; Description?: string;
  IPv4_1?: string; NVR?: string; UserLogin?: string; Password?: string; Protocal?: string; CCTV_Type?: string;
  PurchaseDate?: Date | number; OutWarranty?: Date | number; BuyPrice?: number; Status1?: string;
}

const FLOOR_NAMES: Record<string, string> = {
  "00": "ภายนอกอาคาร", "01": "ชั้น 1", "02": "ชั้น 2", "03": "ชั้น 3", "04": "ชั้น 4", "05": "ชั้น 5", "06": "ชั้น 6", "07": "ชั้น 7",
};

const norm = (s: unknown) => String(s ?? "").trim();
const normName = (s: string) => s.toLowerCase().replace(/\s+/g, "").replace(/[()]/g, "");
const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(s);
const toDate = (v: Date | number | undefined) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(Math.round((v - 25569) * 86400 * 1000));
  return isNaN(d.getTime()) || d.getFullYear() < 2000 ? null : d;
};

function detectBrand(desc: string): string {
  const d = desc.toLowerCase();
  if (d.includes("hi-look") || d.includes("hilook")) return "HILOOK";
  if (d.includes("hik")) return "HIKVISION";
  if (d.includes("tp-link") || d.includes("tplink") || d.includes("tp link") || d.includes("vigi")) return "TPLINK";
  if (d.includes("belko")) return "BELKO";
  if (d.includes("dahua")) return "DAHUA";
  return "UNKNOWN";
}

function parseNvrDescription(desc: string) {
  const model = /Model\s*:?\s*([A-Z0-9\-\/]+)/i.exec(desc)?.[1] ?? /\b(DS-[A-Z0-9\-\/]+)/i.exec(desc)?.[1] ?? /\b(VIGI\s+[A-Z0-9\-]+)/i.exec(desc)?.[1] ?? null;
  const serial = /SN\s*:?\s*([A-Z0-9]+)/i.exec(desc)?.[1] ?? /\/\/\s*(\d{10,}[A-Z0-9]+)/.exec(desc)?.[1] ?? null;
  const name = /Name\s*:?\s*([^\/]+?)\s*(\/\/|$)/i.exec(desc)?.[1]?.trim() ?? null;
  return { model, serial, name };
}

async function main() {
  console.log(`[import] reading ${file}${dryRun ? " (dry run)" : ""}`);
  const wb = XLSX.readFile(file, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]!]!;
  const rows = XLSX.utils.sheet_to_json<Row>(ws, { defval: undefined });
  const cams = rows.filter((r) => norm(r.CCTV_Type) === "C" && r.DeviceNo);
  const nvrRows = rows.filter((r) => norm(r.CCTV_Type) === "N" && r.DeviceNo);
  console.log(`[import] ${rows.length} rows: ${cams.length} cameras, ${nvrRows.length} NVRs`);

  // ---- Floors & rooms -------------------------------------------------------
  const floorIds = new Map<string, number>();
  const roomIds = new Map<string, number>(); // key floorCode|roomCode
  const roomNames = new Map<string, string>();
  for (const r of rows) {
    const fc = norm(r.FloorCode).padStart(2, "0");
    const rc = norm(r.RoomCode);
    if (rc && r.RoomName) roomNames.set(`${fc}|${rc}`, norm(r.RoomName));
  }
  const floorCodes = [...new Set(rows.map((r) => norm(r.FloorCode).padStart(2, "0")).filter((c) => c && c !== "00".padStart(2, "0") || c === "00"))].sort();
  for (const code of floorCodes) {
    if (!code) continue;
    const name = FLOOR_NAMES[code] ?? `ชั้น ${code}`;
    if (!dryRun) {
      const f = await prisma.floor.upsert({ where: { code }, update: { name }, create: { code, name, sortOrder: Number(code) } });
      floorIds.set(code, f.id);
    } else floorIds.set(code, 0);
  }
  for (const r of rows) {
    const fc = norm(r.FloorCode).padStart(2, "0");
    const rc = norm(r.RoomCode);
    if (!rc || !floorIds.has(fc)) continue;
    const key = `${fc}|${rc}`;
    if (roomIds.has(key)) continue;
    const name = roomNames.get(key) ?? rc;
    if (!dryRun) {
      const room = await prisma.room.upsert({ where: { floorId_code: { floorId: floorIds.get(fc)!, code: rc } }, update: { name }, create: { floorId: floorIds.get(fc)!, code: rc, name } });
      roomIds.set(key, room.id);
    } else roomIds.set(key, 0);
  }
  console.log(`[import] floors: ${floorIds.size}, rooms: ${roomIds.size}`);

  // ---- NVRs -----------------------------------------------------------------
  const nvrByHost = new Map<string, number>();
  const nvrByName = new Map<string, number>();
  for (const r of nvrRows) {
    const desc = norm(r.Desciption ?? r.Description);
    const { model, serial, name: parsedName } = parseNvrDescription(desc);
    const ipRaw = norm(r.IPv4_1);
    const [host, portStr] = ipRaw.split(":");
    const name = parsedName || norm(r.NVR) || norm(r.DeviceNo);
    const brand = /vigi|tp-?link/i.test(desc) ? "TPLINK" : "HIKVISION";
    const fc = norm(r.FloorCode).padStart(2, "0");
    const data = {
      legacyDeviceNo: norm(r.DeviceNo),
      brand,
      model,
      serialNo: serial,
      host: host ?? "",
      httpPort: portStr ? Number(portStr) : 80,
      rtspPort: 554,
      username: norm(r.UserLogin) || null,
      passwordEnc: r.Password ? await encryptSecret(String(r.Password)) : null,
      maxChannels: /77\d\d/.test(model ?? "") ? 32 : 16,
      notes: [desc, portStr ? `Registry listed HTTP port ${portStr}; verify RTSP port.` : null].filter(Boolean).join("\n"),
      floorId: floorIds.get(fc) ?? null,
      roomId: roomIds.get(`${fc}|${norm(r.RoomCode)}`) ?? null,
      ...(brand === "TPLINK" ? { channelMainPath: "/chn{ch}_main", channelSubPath: "/chn{ch}_sub" } : {}),
    };
    let id = 0;
    if (!dryRun) {
      const n = await prisma.nvr.upsert({ where: { name }, update: data, create: { name, ...data } });
      id = n.id;
    }
    if (host) nvrByHost.set(host, id);
    nvrByName.set(normName(name), id);
    nvrByName.set(normName(norm(r.DeviceNo)), id);
  }
  console.log(`[import] NVRs: ${nvrRows.length}`);

  // ---- Cameras --------------------------------------------------------------
  const flagsSummary = new Map<string, string[]>();
  const addFlag = (flag: string, dev: string) => flagsSummary.set(flag, [...(flagsSummary.get(flag) ?? []), dev]);
  let imported = 0;
  for (const r of cams) {
    const deviceNo = norm(r.DeviceNo);
    const desc = norm(r.Desciption ?? r.Description);
    const ipRaw = norm(r.IPv4_1);
    const plugAndPlay = /plug/i.test(ipRaw) || !ipRaw;
    const host = !plugAndPlay && isIp(ipRaw) ? ipRaw.split(":")[0]! : null;
    const brand = detectBrand(desc);
    const flags: string[] = [];

    // NVR mapping: IP -> host match, otherwise name match
    const nvrRef = norm(r.NVR);
    let nvrId: number | null = null;
    if (nvrRef) {
      const refHost = nvrRef.split(":")[0]!;
      if (isIp(nvrRef) && nvrByHost.has(refHost)) nvrId = nvrByHost.get(refHost)!;
      else if (nvrByName.has(normName(nvrRef))) nvrId = nvrByName.get(normName(nvrRef))!;
      else flags.push("NVR_UNMAPPED");
    } else flags.push("NVR_MISSING");
    if (dryRun) nvrId = null;

    let protocol: string;
    if (plugAndPlay) {
      protocol = "NVR_CHANNEL";
      flags.push("CHANNEL_UNKNOWN");
    } else if (brand === "HIKVISION" || brand === "HILOOK") protocol = "HIKVISION";
    else protocol = "ONVIF";
    if (!plugAndPlay && !host) flags.push("IP_INVALID");

    const fc = norm(r.FloorCode).padStart(2, "0");
    const roomKey = `${fc}|${norm(r.RoomCode)}`;
    const name = desc.split("//").pop()?.trim() || deviceNo;
    const data = {
      name: name.slice(0, 128),
      description: desc || null,
      brand,
      protocol,
      host,
      rtspPort: 554,
      httpPort: 80,
      username: norm(r.UserLogin) || null,
      passwordEnc: r.Password ? await encryptSecret(String(r.Password)) : null,
      nvrId,
      floorId: floorIds.get(fc) ?? null,
      roomId: roomIds.get(roomKey) ?? null,
      isEnabled: norm(r.Status1) !== "1",
      legacyId: r.ID ?? null,
      legacyNvrRef: nvrRef || null,
      purchaseDate: toDate(r.PurchaseDate),
      warrantyEnd: toDate(r.OutWarranty),
      price: r.BuyPrice ? Number(r.BuyPrice) : null,
      importFlags: flags.length ? flags.join(",") : null,
      sortOrder: Number(deviceNo.split("-")[1] ?? 0) || 0,
    };
    for (const f of flags) addFlag(f, deviceNo);
    if (!dryRun) {
      // Never overwrite a channel number or protocol an operator fixed by hand.
      const existing = await prisma.camera.findUnique({ where: { deviceNo } });
      if (existing) {
        const { protocol: _p, nvrChannel: _c, importFlags: _f, ...update } = { ...data, nvrChannel: undefined };
        await prisma.camera.update({ where: { deviceNo }, data: { ...update, importFlags: existing.nvrChannel ? data.importFlags?.replace(/,?CHANNEL_UNKNOWN/, "") || null : data.importFlags } });
      } else {
        await prisma.camera.create({ data: { deviceNo, ...data } });
      }
    }
    imported++;
  }
  console.log(`[import] cameras: ${imported}`);
  for (const [flag, devs] of flagsSummary) console.log(`[import] ${flag}: ${devs.length} -> ${devs.slice(0, 12).join(", ")}${devs.length > 12 ? " ..." : ""}`);
  console.log("[import] done. Next: fix flagged cameras in the UI, then POST /api/system/sync-streams.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
