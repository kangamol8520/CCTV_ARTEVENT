/**
 * One-way sync: device registry (webae) -> CCTV cameras.
 * The registry owns identity/IP/OSD/location/warranty/owner/retired-status (matched by its PK,
 * MA.DevicesMaster.ID, stored as Camera.registryId; legacy rows link by DeviceNo on first sync).
 * CCTV keeps its own operational fields (protocol, stream paths, password, subTranscode, live
 * status). On an IP change (or a brand-new camera) the stream is auto re-discovered.
 */
import { prisma } from "../lib/prisma.ts";
import { audit } from "../lib/audit.ts";
import { env } from "../lib/env.ts";
import { getRegistryCameras, registryConfigured, type RegistryDevice } from "./registry.ts";
import { applyDiscovery, loadPasswords } from "./discovery.ts";
import { syncCamera } from "./go2rtc.ts";

const FLOOR_NAMES: Record<string, string> = { "00": "ภายนอกอาคาร" };
const toDate = (s: string | null) => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) || d.getFullYear() < 2000 ? null : d;
};
const deriveName = (desc: string | null, deviceNo: string) => {
  const n = (desc ?? "").split("//").pop()?.trim();
  return (n || deviceNo).slice(0, 128);
};
const isIp = (s: string | null) => !!s && /^\d{1,3}(\.\d{1,3}){3}$/.test(s.split(":")[0] ?? "");

export interface SyncSummary {
  registryCount: number; created: number; updated: number; ipChanged: number;
  disabled: number; rediscovered: number; rediscoverFailed: number; errors: string[];
}

export async function syncFromRegistry(opts: { rediscover?: boolean; userId?: number | null } = {}): Promise<SyncSummary> {
  if (!registryConfigured()) throw new Error("Registry not configured (REGISTRY_API_URL)");
  const rediscover = opts.rediscover ?? true;
  const devices = await getRegistryCameras();

  // Ensure floors/rooms referenced by the registry exist in CCTV.
  const floorIdByCode = new Map<string, number>();
  const roomIdByKey = new Map<string, number>(); // `${floorCode}|${roomCode}`
  for (const d of devices) {
    const fc = (d.FloorCode ?? "").padStart(2, "0");
    if (fc && !floorIdByCode.has(fc)) {
      const f = await prisma.floor.upsert({ where: { code: fc }, update: {}, create: { code: fc, name: d.FloorName || FLOOR_NAMES[fc] || `ชั้น ${fc}`, sortOrder: Number(fc) || 0 } });
      floorIdByCode.set(fc, f.id);
    }
    const rc = d.RoomCode ?? "";
    const key = `${fc}|${rc}`;
    if (fc && rc && !roomIdByKey.has(key)) {
      const room = await prisma.room.upsert({ where: { floorId_code: { floorId: floorIdByCode.get(fc)!, code: rc } }, update: {}, create: { floorId: floorIdByCode.get(fc)!, code: rc, name: d.RoomName || rc } });
      roomIdByKey.set(key, room.id);
    }
  }

  const summary: SyncSummary = { registryCount: devices.length, created: 0, updated: 0, ipChanged: 0, disabled: 0, rediscovered: 0, rediscoverFailed: 0, errors: [] };
  const toRediscover: number[] = [];

  for (const d of devices) {
    try {
      const fc = (d.FloorCode ?? "").padStart(2, "0");
      const floorId = floorIdByCode.get(fc) ?? null;
      const roomId = roomIdByKey.get(`${fc}|${d.RoomCode ?? ""}`) ?? null;
      const host = isIp(d.IPv4_1) ? d.IPv4_1!.split(":")[0]! : null;
      const enabled = String(d.Status1) !== "1";
      const common = {
        name: deriveName(d.Desciption, d.DeviceNo),
        description: d.Desciption,
        floorId, roomId,
        owner: d.OwnerName || d.Owner || null,
        secondaryIp: d.IPv4_2 || null,
        purchaseDate: toDate(d.PurchaseDate),
        warrantyEnd: toDate(d.OutWarranty),
        isEnabled: enabled,
        registryId: d.ID,
        registrySyncedAt: new Date(),
      };

      // Match by registryId, else adopt a legacy row by DeviceNo.
      let cam = await prisma.camera.findFirst({ where: { registryId: d.ID } });
      if (!cam) cam = await prisma.camera.findUnique({ where: { deviceNo: d.DeviceNo } });

      if (!cam) {
        const created = await prisma.camera.create({
          data: { deviceNo: d.DeviceNo, ...common, host, protocol: host ? "ONVIF" : "NVR_CHANNEL", rtspPort: 554, httpPort: 80, status: "UNKNOWN", importFlags: host ? "NEW_FROM_REGISTRY" : "PLUGANDPLAY_NEEDS_CHANNEL" },
        });
        summary.created++;
        if (host && enabled) toRediscover.push(created.id);
        continue;
      }

      const ipChanged = host !== null && host !== cam.host;
      const data: Record<string, unknown> = { ...common };
      if (host !== null) data.host = host; // keep existing host if registry has no valid IP
      if (ipChanged) { data.importFlags = "IP_CHANGED"; summary.ipChanged++; }
      await prisma.camera.update({ where: { id: cam.id }, data });
      summary.updated++;
      if (!enabled && cam.isEnabled) summary.disabled++;

      if (ipChanged && enabled) toRediscover.push(cam.id);
      else if (!enabled) await syncCamera(cam.id).catch(() => {}); // drop stream for retired cams
    } catch (e) {
      summary.errors.push(`${d.DeviceNo}: ${(e as Error).message}`);
    }
  }

  if (rediscover && toRediscover.length) {
    const pws = loadPasswords();
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(4, toRediscover.length) }, async () => {
      while (i < toRediscover.length) {
        const id = toRediscover[i++]!;
        const r = await applyDiscovery(id, { pws }).catch(() => ({ ok: false }));
        if (r.ok) summary.rediscovered++; else summary.rediscoverFailed++;
      }
    }));
  }

  await audit(opts.userId ?? null, "SYNC", "Registry", undefined, { registryCount: summary.registryCount, created: summary.created, updated: summary.updated, ipChanged: summary.ipChanged });
  return summary;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startRegistrySyncScheduler() {
  if (!registryConfigured() || !env.registrySyncInterval) return;
  const tick = () => syncFromRegistry({}).then((s) => console.log("[registry-sync]", { created: s.created, updated: s.updated, ipChanged: s.ipChanged, rediscovered: s.rediscovered })).catch((e) => console.error("[registry-sync]", e.message));
  timer = setInterval(tick, env.registrySyncInterval * 1000);
  setTimeout(tick, 15000);
}
