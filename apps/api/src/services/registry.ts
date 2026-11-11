/**
 * Client for the webae device-registry backend (Express + MSSQL) at REGISTRY_API_URL.
 * Read: device list + detail + repair history. Write: edit-device (NEVER delete), insertrepairdoc.
 * TLS: the registry's self-signed cert is pinned as a trusted CA (verification stays ON).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../lib/env.ts";

let caCache: string | null | undefined;
function ca(): string | undefined {
  if (caCache === undefined) {
    try { caCache = env.registryCaFile ? readFileSync(resolve(import.meta.dir, "../../", env.registryCaFile), "utf8") : null; }
    catch { caCache = null; }
  }
  return caCache ?? undefined;
}

export function registryConfigured(): boolean {
  return !!env.registryApiUrl;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!env.registryApiUrl) throw new Error("REGISTRY_API_URL not configured");
  const res = await fetch(`${env.registryApiUrl}/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
    tls: ca() ? { ca: ca() } : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`registry ${init.method ?? "GET"} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export interface RegistryDevice {
  ID: number; DeviceNo: string; JobTypeCode?: string; CategoryName?: string;
  FloorCode: string | null; RoomCode: string | null; FloorName?: string | null; RoomName?: string | null;
  IPv4_1: string | null; IPv4_2: string | null; Desciption: string | null;
  PurchaseDate: string | null; OutWarranty: string | null; Owner: string | null; OwnerName?: string | null;
  Status1: string | null; Picture1?: string | null; Picture2?: string | null;
  /** Added 2026-11-11 for CCTV: NVR PoE port of a plug&play camera / RTSP port / stream protocol. */
  Physical_PORT?: string | null; Network_PORT?: string | null; PROTOCOL?: string | null;
}

async function floorCodes(): Promise<string[]> {
  const rows = await req<{ FloorCode: string }[]>("getfloor");
  return rows.map((r) => r.FloorCode);
}
async function roomCodes(): Promise<string[]> {
  const rows = await req<{ RoomCode: string }[]>("getroom");
  return rows.map((r) => r.RoomCode);
}

/** Every CCTV-category device in the registry: cameras and NVR-* recorders. */
export async function getRegistryDevices(): Promise<RegistryDevice[]> {
  const [floors, rooms] = await Promise.all([floorCodes(), roomCodes()]);
  const body = JSON.stringify({ filterJob: [env.registryJobType], filterCate: [env.registryCategory], filterFloor: floors, filterRoom: rooms });
  const rows = await req<RegistryDevice[]>("getdevicemaster", { method: "POST", body });
  return (Array.isArray(rows) ? rows : []).filter((d) => d.DeviceNo);
}
export const isRegistryNvr = (d: { DeviceNo: string }) => /^NVR/i.test(d.DeviceNo);

/** All CCTV cameras in the registry (excludes NVR-* devices). */
export async function getRegistryCameras(): Promise<RegistryDevice[]> {
  return (await getRegistryDevices()).filter((d) => !isRegistryNvr(d));
}

export interface RegistryDetail {
  dataDevice?: Record<string, unknown>;
  UserLogin?: { UserLogin?: string; Password?: string; LoginType?: string }[] | Record<string, unknown>;
  LoginType?: unknown; LoginTypePolicy?: unknown; LicenseList?: unknown; LicenseDevice?: unknown;
}
export async function getRegistryDetail(registryId: number): Promise<RegistryDetail> {
  return req<RegistryDetail>(`getDataDevice/${registryId}`);
}
export async function getRegistryRepairs(registryId: number): Promise<unknown> {
  return req(`getRepairDetail/${registryId}`);
}

/** Edit a device in the registry. The backend UPDATEs every column, so we send the full record
 *  (current values merged with the patch). We NEVER call the delete endpoint. */
export interface RegistryRecord {
  JobTypeCode: string; CategoryCode: string; DeviceNo: string; FloorCode: string; RoomCode: string;
  PurchaseDate: string; OutWarranty: string; Owner: string; Desciption: string; Status1: string;
  IPv4_1: string; IPv4_2: string;
  /** Optional: the backend COALESCEs these, so leaving one out keeps its stored value; "" clears it. */
  Physical_PORT?: string; Network_PORT?: string; PROTOCOL?: string;
}
export async function editRegistryDevice(registryId: number, record: RegistryRecord): Promise<unknown> {
  const res = await req<{ result?: string }>(`edit-device/${registryId}`, { method: "POST", body: JSON.stringify(record) });
  if (res?.result !== "ok") throw new Error(`edit-device refused: ${JSON.stringify(res).slice(0, 200)}`);
  return res;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const dateStr = (v: unknown) => { const d = v ? new Date(String(v)) : null; return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : ""; };

/** Reads the device's current record, applies `patch` and writes the full record back (edit-device
 *  rewrites all 12 legacy columns, quoting each value, so NULLs become "" — accepted by the owner). */
export async function patchRegistryDevice(registryId: number, patch: Partial<RegistryRecord>, fallbackDeviceNo = ""): Promise<RegistryRecord> {
  const detail = await getRegistryDetail(registryId);
  const raw = detail.dataDevice as unknown;
  const cur = ((Array.isArray(raw) ? raw[0] : raw) ?? {}) as Record<string, unknown>;
  if (!str(cur.DeviceNo) && !fallbackDeviceNo) throw new Error(`registry device ${registryId} not found`);
  // An empty date would be stored as 1900-01-01 by the backend — refuse rather than corrupt it.
  if (!dateStr(cur.PurchaseDate) || !dateStr(cur.OutWarranty)) throw new Error("ทะเบียนไม่มีวันที่ซื้อ/หมดประกัน — แก้ในระบบทะเบียนก่อน");
  const record: RegistryRecord = {
    JobTypeCode: str(cur.JobTypeCode) || env.registryJobType,
    CategoryCode: str(cur.CategoryCode) || env.registryCategory,
    DeviceNo: str(cur.DeviceNo) || fallbackDeviceNo,
    FloorCode: str(cur.FloorCode),
    RoomCode: str(cur.RoomCode),
    PurchaseDate: dateStr(cur.PurchaseDate),
    OutWarranty: dateStr(cur.OutWarranty),
    Owner: str(cur.Owner),
    Desciption: str(cur.Desciption),
    Status1: str(cur.Status1) || "0",
    IPv4_1: str(cur.IPv4_1),
    IPv4_2: str(cur.IPv4_2),
    ...patch,
  };
  // The backend builds SQL by string concatenation for the legacy columns.
  for (const k of ["JobTypeCode", "CategoryCode", "DeviceNo", "FloorCode", "RoomCode", "Owner", "Desciption", "Status1", "IPv4_1", "IPv4_2"] as const) {
    if (record[k].includes("'")) throw new Error(`ห้ามใช้เครื่องหมาย ' ใน ${k}`);
  }
  await editRegistryDevice(registryId, record);
  return record;
}

/** The three CCTV columns as stored in the registry, derived from a camera's own settings. */
export function cameraPortFields(c: { protocol: string; rtspPort: number; nvrChannel: number | null }) {
  const plug = c.protocol === "NVR_CHANNEL";
  return { PROTOCOL: c.protocol, Physical_PORT: plug && c.nvrChannel ? String(c.nvrChannel) : "", Network_PORT: plug ? "" : String(c.rtspPort) };
}

export interface RepairTicket { BillDoc: string; Status: string; StatusName?: string; JobDate: string; BrokenDes?: string }

/** Open (not finished) repair tickets of a device — Status "3" = ดำเนินการเสร็จ. */
export async function openRepairs(registryId: number): Promise<RepairTicket[]> {
  const rows = await getRegistryRepairs(registryId);
  return (Array.isArray(rows) ? (rows as RepairTicket[]) : []).filter((r) => r.Status !== "3");
}

/** Files a repair ticket (ใบแจ้งซ่อม) for a device. Payload shape as given by the registry owner. */
export async function insertRepairDoc(t: {
  deviceNo: string; floorCode: string; roomCode: string; brokenDes: string; date?: Date;
  /** Reporter EmpCode / phone; default to REPAIR_CONTACT_PERSON / REPAIR_TEL (dev values). */
  contactPerson?: string; tel?: string;
}): Promise<unknown> {
  const contactPerson = t.contactPerson || env.repairContactPerson;
  if (!contactPerson) throw new Error("Reporter (ContactPerson) is required");
  // The backend answers {"message":"nok"} (HTTP 200, nothing saved) when BrokenDes is ~200+ chars.
  if (t.brokenDes.length > 190) throw new Error("BrokenDes must be 190 characters or fewer");
  const body = {
    BrokenDes: t.brokenDes,
    CategoryCode: env.registryCategory,
    ContactPerson: contactPerson,
    DeviceNo: t.deviceNo,
    // Local (Asia/Bangkok) calendar date, not UTC — before 07:00 the UTC date is still yesterday.
    DueDate: new Date((t.date ?? new Date()).getTime() + 7 * 3600_000).toISOString().slice(0, 10),
    FloorCode: t.floorCode,
    JobTypeCode: env.registryJobType,
    RoomCode: t.roomCode,
    Status: "0",
    Tel: t.tel || env.repairTel,
    ApprovStatus: 0,
    RepairBillNo: "",
    JobLevel: null,
    Priority: null,
    Rating: null,
    AlertDate: null,
    AlertTitle: null,
    IsAlert: null,
  };
  const res = await req<{ message?: string; result?: { BillID: number }[] }>("insertrepairdoc", { method: "POST", body: JSON.stringify(body) });
  if (res.message !== "ok") throw new Error(`insertrepairdoc refused: ${JSON.stringify(res).slice(0, 200)}`);
  return res;
}
