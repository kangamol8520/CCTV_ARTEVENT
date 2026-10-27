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

function noteFor(d: { kind: "cam" | "nvr"; protocol?: string; nvrChannel?: number | null; importFlags?: string | null; brand?: string; hasPw: boolean; status: string; matched: boolean }): string {
  const n: string[] = [];
  if (d.kind === "nvr") {
    if (!d.matched) n.push("รหัสไม่ตรง 3 ตัว หรือพอร์ตบนเครื่องไม่ใช่ 80 — ตรวจหน้างาน");
    return n.join("; ");
  }
  if (d.protocol === "NVR_CHANNEL") {
    if (!d.nvrChannel) n.push("Plug&Play: ใส่หมายเลขช่องบน NVR");
  }
  if (d.importFlags?.includes("NVR_UNMAPPED")) n.push("NVR ที่อ้างถึงไม่มีในทะเบียน");
  if (d.importFlags?.includes("NVR_MISSING")) n.push("ยังไม่ผูก NVR");
  if (d.protocol === "ONVIF" && d.status !== "ONLINE") n.push("ONVIF ไม่ตอบ — ตรวจ IP/พอร์ต");
  if (d.protocol === "ONVIF" && d.status === "ONLINE" && (d.brand === "BELKO" || d.brand === "UNKNOWN")) n.push("RTSP 554 เปิดอยู่แต่ path ONVIF ไม่ทราบ — ขอ RTSP path ของกล้อง");
  if (d.protocol === "HIKVISION" && d.status === "ONLINE" && !d.matched) n.push("Hikvision แต่รหัสทั้ง 3 ตัวไม่ผ่าน — อาจใช้รหัสอื่น");
  return n.join("; ");
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
        const matched = n.status === "ONLINE";
        row["สถานะ Up/Down"] = upDown(n.status);
        row["พอร์ต HTTP (LAN)"] = n.httpPort;
        row["ต้องแก้ไข"] = noteFor({ kind: "nvr", hasPw: !!n.passwordEnc, status: n.status, matched });
        nvrFilled++;
      }
    } else {
      const c = camByDev.get(dev);
      if (c) {
        const pw = await decryptSecret(c.passwordEnc);
        row.UserLogin = c.username ?? "admin";
        row.Password = pw ?? "";
        row["สถานะ Up/Down"] = upDown(c.status);
        row["โปรโตคอล (ระบบ)"] = c.protocol;
        row["ช่อง NVR"] = c.nvrChannel ?? "";
        row["NVR ที่ผูก"] = c.nvr?.name ?? "";
        row["ต้องแก้ไข"] = noteFor({ kind: "cam", protocol: c.protocol, nvrChannel: c.nvrChannel, importFlags: c.importFlags, brand: c.brand, hasPw: !!c.passwordEnc, status: c.status, matched: c.status === "ONLINE" && !!c.passwordEnc });
        camFilled++;
      }
    }
  }

  // Explicit column order: original meaningful columns, then the new system columns right
  // after Password; drop the blank __EMPTY columns that the source file carried.
  const NEW_COLS = ["สถานะ Up/Down", "โปรโตคอล (ระบบ)", "NVR ที่ผูก", "ช่อง NVR", "พอร์ต HTTP (LAN)", "ต้องแก้ไข"];
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
  const summary = [
    { รายการ: "กล้องทั้งหมด", จำนวน: cams.length },
    { รายการ: "กล้อง Up", จำนวน: cams.filter((c) => c.status === "ONLINE").length },
    { รายการ: "กล้อง Down", จำนวน: cams.filter((c) => c.status === "OFFLINE").length },
    { รายการ: "กล้องมีรหัสในระบบ", จำนวน: cams.filter((c) => c.passwordEnc).length },
    { รายการ: "NVR ทั้งหมด", จำนวน: nvrs.length },
    { รายการ: "NVR Up", จำนวน: nvrs.filter((n) => n.status === "ONLINE").length },
    { รายการ: "NVR มีรหัสในระบบ", จำนวน: nvrs.filter((n) => n.passwordEnc).length },
  ];
  XLSX.utils.book_append_sheet(outWb, XLSX.utils.json_to_sheet(summary), "สรุป");

  XLSX.writeFile(outWb, outFile);
  console.log(`[export] wrote ${outFile}`);
  console.log(`[export] rows: ${rows.length}, cameras filled: ${camFilled}, NVRs filled: ${nvrFilled}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
