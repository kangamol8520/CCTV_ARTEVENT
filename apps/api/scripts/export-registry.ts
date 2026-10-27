/**
 * Exports the registry back to Excel with current username/password (decrypted) and an
 * Up/Down status column, so the operator can reconcile devices by hand.
 *
 *   bun run scripts/export-registry.ts [output.xlsx]
 *
 * WARNING: the output contains plaintext device passwords. It is written under registry/
 * (git-ignored). Keep it off shared drives.
 */
import * as XLSX from "xlsx";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/lib/prisma.ts";
import { decryptSecret } from "../src/lib/crypto.ts";

const registryDir = resolve(import.meta.dir, "../../../registry");
const srcFile = (() => {
  const xlsx = readdirSync(registryDir).filter((f) => f.endsWith(".xlsx") && !f.startsWith("~$") && !f.includes("อัปเดต"));
  if (!xlsx.length) throw new Error(`No source .xlsx in ${registryDir}`);
  return resolve(registryDir, xlsx[0]!);
})();
const outFile = process.argv[2] ?? resolve(registryDir, "ทะเบียน CCTV อัปเดตรหัสและสถานะ.xlsx");

const upDown = (s: string) => (s === "ONLINE" ? "Up" : s === "OFFLINE" ? "Down" : "ไม่ทราบ");

/** True when the system has everything it needs to pull this camera's stream. */
function configReady(c: { protocol: string; mainStreamPath: string | null; passwordEnc: string | null; nvrChannel: number | null }): boolean {
  if (c.protocol === "RTSP") return !!c.mainStreamPath;
  if (c.protocol === "HIKVISION") return !!c.passwordEnc;
  if (c.protocol === "NVR_CHANNEL") return !!c.nvrChannel;
  return false;
}

function camNote(c: { protocol: string; status: string; mainStreamPath: string | null; passwordEnc: string | null; nvrChannel: number | null }): string {
  const ready = configReady(c);
  if (ready && c.status === "ONLINE") return ""; // streaming, nothing to do
  if (c.protocol === "NVR_CHANNEL" && !c.nvrChannel) return "Plug&Play: กรอกเลขช่องในคอลัมน์ 'กรอกช่อง NVR ตรงนี้'";
  if (c.status !== "ONLINE") return "กล้องออฟไลน์ — ตรวจหน้างาน (กล้องเสีย / IP เปลี่ยน / ปิดเครื่อง)";
  if (c.protocol === "ONVIF") return "ONVIF ยังเจาะไม่ได้ — ต้องการรหัสตัวที่ 4 หรือเปิด ONVIF ในกล้อง / บอก RTSP path";
  if (ready && c.status !== "ONLINE") return "ตั้งค่าแล้วแต่ตอนนี้ออฟไลน์";
  return "ตรวจสอบการตั้งค่า";
}

function nvrNote(n: { status: string }): string {
  return n.status === "ONLINE" ? "" : "NVR ออฟไลน์ / รหัสไม่ตรง 3 ตัว — ตรวจหน้างาน";
}

async function main() {
  const cams = await prisma.camera.findMany({ include: { nvr: true } });
  const nvrs = await prisma.nvr.findMany();
  const camByDev = new Map(cams.map((c) => [c.deviceNo, c]));
  const nvrByDev = new Map(nvrs.map((n) => [n.legacyDeviceNo ?? n.name, n]));

  const wb = XLSX.readFile(srcFile, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]!]!;
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: null });

  let camFilled = 0, nvrFilled = 0;
  for (const row of rows) {
    const dev = String(row.DeviceNo ?? "").trim();
    const type = String(row.CCTV_Type ?? "").trim();
    if (type === "N") {
      const n = nvrByDev.get(dev);
      if (n) {
        row.UserLogin = n.username ?? "admin";
        row.Password = (await decryptSecret(n.passwordEnc)) ?? "";
        row["สตรีมได้แล้ว"] = "";
        row["สถานะ Up/Down"] = upDown(n.status);
        row["โปรโตคอล (ระบบ)"] = "NVR";
        row["NVR ที่ผูก"] = "";
        row["ช่อง NVR"] = "";
        row["กรอกช่อง NVR ตรงนี้"] = "";
        row["พอร์ต HTTP (LAN)"] = n.httpPort;
        row["ต้องแก้ไข"] = nvrNote(n);
        nvrFilled++;
      }
    } else {
      const c = camByDev.get(dev);
      if (c) {
        const pw = await decryptSecret(c.passwordEnc);
        const streaming = configReady(c) && c.status === "ONLINE";
        row.UserLogin = c.username ?? "admin";
        row.Password = pw ?? "";
        row["สตรีมได้แล้ว"] = streaming ? "ใช่" : "ยัง";
        row["สถานะ Up/Down"] = upDown(c.status);
        row["โปรโตคอล (ระบบ)"] = c.protocol === "NVR_CHANNEL" ? "Plug&Play (ผ่าน NVR)" : c.protocol;
        row["NVR ที่ผูก"] = c.nvr?.name ?? "";
        row["ช่อง NVR"] = c.nvrChannel ?? "";
        // Blank input column for the operator to fill the plug&play channel; "-" for the rest.
        row["กรอกช่อง NVR ตรงนี้"] = c.protocol === "NVR_CHANNEL" ? (c.nvrChannel ?? "") : "-";
        row["ต้องแก้ไข"] = camNote(c);
        camFilled++;
      }
    }
  }

  // Explicit column order: original meaningful columns, then the new system columns right
  // after Password; drop the blank __EMPTY columns that the source file carried.
  const NEW_COLS = ["สตรีมได้แล้ว", "สถานะ Up/Down", "โปรโตคอล (ระบบ)", "NVR ที่ผูก", "ช่อง NVR", "กรอกช่อง NVR ตรงนี้", "พอร์ต HTTP (LAN)", "ต้องแก้ไข"];
  const srcCols = (Object.keys(rows[0] ?? {})).filter((k) => !k.startsWith("__EMPTY") && !NEW_COLS.includes(k));
  const pwIdx = srcCols.indexOf("Password");
  const ordered = pwIdx >= 0 ? [...srcCols.slice(0, pwIdx + 1), ...NEW_COLS, ...srcCols.slice(pwIdx + 1)] : [...srcCols, ...NEW_COLS];
  const header = ordered;
  const aoa: any[][] = [header, ...rows.map((r) => header.map((h) => r[h] ?? ""))];
  const outWs = XLSX.utils.aoa_to_sheet(aoa);
  // freeze header + first columns, set a readable width on the note column
  outWs["!freeze"] = { xSplit: 0, ySplit: 1 } as any;
  const noteCol = header.indexOf("ต้องแก้ไข");
  outWs["!cols"] = header.map((h, i) => ({ wch: i === noteCol ? 48 : h === "Desciption" ? 30 : h === "NVR ที่ผูก" ? 16 : 12 }));
  const outWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outWb, outWs, "ทะเบียน");

  // summary sheet
  const streamingCams = cams.filter((c) => configReady(c) && c.status === "ONLINE");
  const plugWaiting = cams.filter((c) => c.protocol === "NVR_CHANNEL" && !c.nvrChannel);
  const onvifLeft = cams.filter((c) => c.protocol === "ONVIF");
  const summary = [
    { รายการ: "กล้องทั้งหมด (เปิดใช้งาน)", จำนวน: cams.filter((c) => c.isEnabled).length },
    { รายการ: "สตรีมได้แล้ว (ขึ้นภาพ)", จำนวน: streamingCams.length },
    { รายการ: "Plug&Play รอกรอกเลขช่อง NVR", จำนวน: plugWaiting.length },
    { รายการ: "ONVIF ยังเจาะไม่ได้ (รอรหัส#4 / เปิด ONVIF)", จำนวน: onvifLeft.length },
    { รายการ: "กล้อง Up (เครือข่าย)", จำนวน: cams.filter((c) => c.status === "ONLINE").length },
    { รายการ: "กล้อง Down (เครือข่าย)", จำนวน: cams.filter((c) => c.status === "OFFLINE").length },
    { รายการ: "NVR ทั้งหมด", จำนวน: nvrs.length },
    { รายการ: "NVR Up", จำนวน: nvrs.filter((n) => n.status === "ONLINE").length },
  ];
  XLSX.utils.book_append_sheet(outWb, XLSX.utils.json_to_sheet(summary), "สรุป");

  XLSX.writeFile(outWb, outFile);
  console.log(`[export] wrote ${outFile}`);
  console.log(`[export] rows: ${rows.length}, cameras filled: ${camFilled}, NVRs filled: ${nvrFilled}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
