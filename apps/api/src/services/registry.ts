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
}

async function floorCodes(): Promise<string[]> {
  const rows = await req<{ FloorCode: string }[]>("getfloor");
  return rows.map((r) => r.FloorCode);
}
async function roomCodes(): Promise<string[]> {
  const rows = await req<{ RoomCode: string }[]>("getroom");
  return rows.map((r) => r.RoomCode);
}

/** All CCTV cameras in the registry (excludes NVR-* devices). */
export async function getRegistryCameras(): Promise<RegistryDevice[]> {
  const [floors, rooms] = await Promise.all([floorCodes(), roomCodes()]);
  const body = JSON.stringify({ filterJob: [env.registryJobType], filterCate: [env.registryCategory], filterFloor: floors, filterRoom: rooms });
  const rows = await req<RegistryDevice[]>("getdevicemaster", { method: "POST", body });
  return (Array.isArray(rows) ? rows : []).filter((d) => d.DeviceNo && !/^NVR/i.test(d.DeviceNo));
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
export async function editRegistryDevice(registryId: number, record: {
  JobTypeCode: string; CategoryCode: string; DeviceNo: string; FloorCode: string; RoomCode: string;
  PurchaseDate: string; OutWarranty: string; Owner: string; Desciption: string; Status1: string;
  IPv4_1: string; IPv4_2: string;
}): Promise<unknown> {
  return req(`edit-device/${registryId}`, { method: "POST", body: JSON.stringify(record) });
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
