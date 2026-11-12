/**
 * One-way sync: device registry (webae) -> CCTV cameras.
 * The registry owns identity/IP/OSD/location/warranty/owner/retired-status (matched by its PK,
 * MA.DevicesMaster.ID, stored as Camera.registryId; legacy rows link by DeviceNo on first sync).
 * Since 2026-11-11 the registry also owns PROTOCOL / Network_PORT (RTSP) / Physical_PORT (NVR
 * PoE port of a plug&play camera) and each NVR-* row's RTSP port. A blank registry value keeps the
 * CCTV value. CCTV still keeps stream paths, password, subTranscode and live status.
 * On an IP change (or a brand-new camera) the stream is auto re-discovered; when only the
 * protocol/port/channel changes the stream is re-registered.
 */
import { prisma } from "../lib/prisma.ts";
import { audit } from "../lib/audit.ts";
import { env } from "../lib/env.ts";
import { cameraPortFields, getRegistryDevices, isRegistryNvr, patchRegistryDevice, registryConfigured } from "./registry.ts";
import { applyDiscovery, loadPasswords } from "./discovery.ts";
import { syncCamera } from "./go2rtc.ts";

// Host prefixes to keep hidden (unreachable / foreign subnets), e.g. the new parking lot.
const HIDDEN_HOST_PREFIXES = (process.env.HIDDEN_HOST_PREFIXES ?? "192.168.19.").split(",").map((s) => s.trim()).filter(Boolean);
const isHiddenHost = (h: string | null) => !!h && HIDDEN_HOST_PREFIXES.some((p) => h.startsWith(p));

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
const ipOf = (s: string | null | undefined) => (s && isIp(s) ? s.split(":")[0]!.trim() : null);

const PROTOCOLS = new Set(["HIKVISION", "ONVIF", "RTSP", "NVR_CHANNEL"]);
const intIn = (v: unknown, max: number) => {
  const t = String(v ?? "").trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= max ? n : undefined;
};
/** Registry PROTOCOL / Network_PORT / Physical_PORT → Camera fields. Blank or invalid values are
 *  left out, so they never overwrite what CCTV already has. */
export function cameraPortsFromRegistry(d: { PROTOCOL?: string | null; Network_PORT?: string | null; Physical_PORT?: string | null }) {
  const out: { protocol?: string; rtspPort?: number; nvrChannel?: number } = {};
  const proto = String(d.PROTOCOL ?? "").trim().toUpperCase();
  if (PROTOCOLS.has(proto)) out.protocol = proto;
  const port = intIn(d.Network_PORT, 65535);
  if (port) out.rtspPort = port;
  const ch = intIn(d.Physical_PORT, 256);
  if (ch) out.nvrChannel = ch;
  return out;
}

/** Writes a camera's protocol / RTSP port / NVR channel back to the registry. Called whenever CCTV
 *  itself changes them (discovery, the camera edit form) so the next sync does not revert them. */
export async function pushCameraPorts(cameraId: number): Promise<boolean> {
  if (!registryConfigured()) return false;
  const c = await prisma.camera.findUnique({ where: { id: cameraId }, select: { deviceNo: true, registryId: true, protocol: true, rtspPort: true, nvrChannel: true } });
  if (!c?.registryId) return false;
  try {
    await patchRegistryDevice(c.registryId, cameraPortFields(c), c.deviceNo);
    return true;
  } catch (e) {
    console.error("[registry] push ports", c.deviceNo, (e as Error).message);
    return false;
  }
}

/** Same for an NVR's RTSP port (its NVR-* row, matched by DeviceNo, else by IP). */
export async function pushNvrPort(nvrId: number): Promise<boolean> {
  if (!registryConfigured()) return false;
  const n = await prisma.nvr.findUnique({ where: { id: nvrId }, select: { host: true, legacyDeviceNo: true, rtspPort: true } });
  if (!n) return false;
  try {
    const rows = (await getRegistryDevices()).filter(isRegistryNvr);
    const r = rows.find((d) => d.DeviceNo === n.legacyDeviceNo) ?? rows.find((d) => ipOf(d.IPv4_1) === n.host);
    if (!r) return false;
    await patchRegistryDevice(r.ID, { Network_PORT: String(n.rtspPort) }, r.DeviceNo);
    return true;
  } catch (e) {
    console.error("[registry] push NVR port", n.host, (e as Error).message);
    return false;
  }
}

export interface SyncSummary {
  registryCount: number; created: number; updated: number; ipChanged: number;
  disabled: number; rediscovered: number; rediscoverFailed: number;
  /** Cameras/NVRs whose protocol, RTSP port or NVR channel was changed from the registry. */
  portsChanged: string[];
  errors: string[];
}

export async function syncFromRegistry(opts: { rediscover?: boolean; userId?: number | null } = {}): Promise<SyncSummary> {
  if (!registryConfigured()) throw new Error("Registry not configured (REGISTRY_API_URL)");
  const rediscover = opts.rediscover ?? true;
  const all = await getRegistryDevices();
  const devices = all.filter((d) => !isRegistryNvr(d));
  const nvrs = await prisma.nvr.findMany({ select: { id: true, name: true, host: true, legacyDeviceNo: true, rtspPort: true } });
  const nvrByHost = new Map(nvrs.map((n) => [n.host, n]));

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

  const summary: SyncSummary = { registryCount: devices.length, created: 0, updated: 0, ipChanged: 0, disabled: 0, rediscovered: 0, rediscoverFailed: 0, portsChanged: [], errors: [] };
  const toRediscover: number[] = [];
  const toResync = new Set<number>();
  // Cameras whose PROTOCOL is set in the registry: discovery must not write its own result over it.
  const registryOwnsProtocol = new Set<number>();

  // NVR-* rows: the registry's Network_PORT is the NVR's RTSP port. Matched by DeviceNo, else by IP.
  for (const d of all.filter(isRegistryNvr)) {
    const port = cameraPortsFromRegistry(d).rtspPort;
    if (!port) continue;
    const ip = ipOf(d.IPv4_1);
    const n = nvrs.find((x) => x.legacyDeviceNo === d.DeviceNo) ?? (ip ? nvrByHost.get(ip) : undefined);
    if (!n || n.rtspPort === port) continue;
    await prisma.nvr.update({ where: { id: n.id }, data: { rtspPort: port } });
    summary.portsChanged.push(`${d.DeviceNo} rtspPort ${n.rtspPort}→${port}`);
    n.rtspPort = port;
    for (const c of await prisma.camera.findMany({ where: { nvrId: n.id, isEnabled: true }, select: { id: true } })) toResync.add(c.id);
  }

  for (const d of devices) {
    try {
      const fc = (d.FloorCode ?? "").padStart(2, "0");
      const floorId = floorIdByCode.get(fc) ?? null;
      const roomId = roomIdByKey.get(`${fc}|${d.RoomCode ?? ""}`) ?? null;
      const host = isIp(d.IPv4_1) ? d.IPv4_1!.split(":")[0]! : null;
      // Match by registryId, else adopt a legacy row by DeviceNo.
      let cam = await prisma.camera.findFirst({ where: { registryId: d.ID } });
      if (!cam) cam = await prisma.camera.findUnique({ where: { deviceNo: d.DeviceNo } });

      // Cameras on an unreachable/foreign subnet (e.g. the new parking lot on 192.168.19.x), or
      // already flagged HIDDEN, stay hidden: disabled, flagged, never re-discovered — preserved
      // across syncs even though the registry lists them active.
      const hidden = isHiddenHost(host) || !!cam?.importFlags?.includes("HIDDEN");
      const enabled = String(d.Status1) !== "1" && !hidden;
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
      const ports = cameraPortsFromRegistry(d);
      if (ports.protocol && cam) registryOwnsProtocol.add(cam.id);
      // Plug&play: IPv4_2 holds the NVR's IP — link the camera to that NVR.
      const nvrId = (ports.protocol ?? cam?.protocol) === "NVR_CHANNEL" ? nvrByHost.get(ipOf(d.IPv4_2) ?? "")?.id : undefined;

      if (!cam) {
        const created = await prisma.camera.create({
          data: {
            deviceNo: d.DeviceNo, ...common, host, protocol: host ? "ONVIF" : "NVR_CHANNEL", rtspPort: 554, httpPort: 80, ...ports,
            ...(nvrId ? { nvrId } : {}), status: "UNKNOWN",
            importFlags: hidden ? "HIDDEN_OTHER_NETWORK" : host ? "NEW_FROM_REGISTRY" : ports.nvrChannel ? null : "PLUGANDPLAY_NEEDS_CHANNEL",
          },
        });
        summary.created++;
        // ONVIF needs discovery to find its stream; an explicit protocol from the registry does not.
        if (host && enabled && created.protocol === "ONVIF") toRediscover.push(created.id);
        else if (enabled) toResync.add(created.id);
        continue;
      }

      const ipChanged = host !== null && host !== cam.host;
      const data: Record<string, unknown> = { ...common };
      if (host !== null) data.host = host; // keep existing host if registry has no valid IP
      const changed: string[] = [];
      const camRec = cam as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries({ ...ports, ...(nvrId ? { nvrId } : {}) })) {
        if (camRec[k] !== v) { data[k] = v; changed.push(`${k} ${camRec[k] ?? "-"}→${v}`); }
      }
      if (changed.length) {
        summary.portsChanged.push(`${d.DeviceNo} ${changed.join(", ")}`);
        // The channel is now known: clear the importer's "needs channel" flag.
        if (ports.nvrChannel && cam.importFlags?.includes("PLUGANDPLAY_NEEDS_CHANNEL")) data.importFlags = null;
      }
      if (hidden) data.importFlags = "HIDDEN_OTHER_NETWORK";
      else if (ipChanged) { data.importFlags = "IP_CHANGED"; summary.ipChanged++; }
      await prisma.camera.update({ where: { id: cam.id }, data });
      summary.updated++;
      if (!enabled && cam.isEnabled) summary.disabled++;

      if (ipChanged && enabled && !hidden) toRediscover.push(cam.id);
      else if (changed.length && enabled && !hidden) toResync.add(cam.id);
      else if (!enabled && cam.isEnabled) await syncCamera(cam.id).catch(() => {}); // drop stream once, when a cam becomes disabled/hidden
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
        if (r.ok) {
          summary.rediscovered++;
          // Discovery found credentials/paths; keep the registry's protocol if it has one (the next sync
          // re-applies it), otherwise record what was found.
          if (!registryOwnsProtocol.has(id)) await pushCameraPorts(id);
        } else summary.rediscoverFailed++;
      }
    }));
  }

  for (const id of toRediscover) toResync.delete(id);
  for (const id of toResync) await syncCamera(id).catch((e) => summary.errors.push(`resync ${id}: ${(e as Error).message}`));

  await audit(opts.userId ?? null, "SYNC", "Registry", undefined, { registryCount: summary.registryCount, created: summary.created, updated: summary.updated, ipChanged: summary.ipChanged, portsChanged: summary.portsChanged });
  return summary;
}

// ── Scheduler ────────────────────────────────────────────────────────────────────────────────
// The interval is editable at runtime (Setting "registry.syncIntervalSec"; 0 = off). Until someone
// sets it, REGISTRY_SYNC_INTERVAL from .env is used. Runs never overlap: a manual sync while a
// scheduled one is running waits for and returns that run.
export const SYNC_INTERVAL_KEY = "registry.syncIntervalSec";
export const SYNC_INTERVAL_MIN = 60;
export const SYNC_INTERVAL_MAX = 24 * 3600;

const state: {
  intervalSec: number; timer: ReturnType<typeof setTimeout> | null; running: Promise<SyncSummary> | null;
  lastRunAt: Date | null; lastOk: boolean | null; lastError: string | null; lastSummary: Partial<SyncSummary> | null; nextRunAt: Date | null;
} = { intervalSec: 0, timer: null, running: null, lastRunAt: null, lastOk: null, lastError: null, lastSummary: null, nextRunAt: null };

/** Runs a sync, or joins the one already running. Used by both the scheduler and the button. */
export function runRegistrySync(opts: { rediscover?: boolean; userId?: number | null } = {}): Promise<SyncSummary> {
  if (state.running) return state.running;
  state.running = syncFromRegistry(opts)
    .then((s) => {
      state.lastOk = true; state.lastError = null;
      state.lastSummary = { registryCount: s.registryCount, created: s.created, updated: s.updated, ipChanged: s.ipChanged, rediscovered: s.rediscovered, portsChanged: s.portsChanged, errors: s.errors.slice(0, 20) };
      return s;
    })
    .catch((e) => { state.lastOk = false; state.lastError = (e as Error).message; throw e; })
    .finally(() => { state.lastRunAt = new Date(); state.running = null; });
  return state.running;
}

function schedule(delayMs: number) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null; state.nextRunAt = null;
  if (!state.intervalSec || !registryConfigured()) return;
  state.nextRunAt = new Date(Date.now() + delayMs);
  state.timer = setTimeout(async () => {
    await runRegistrySync({})
      .then((s) => console.log("[registry-sync]", { created: s.created, updated: s.updated, ipChanged: s.ipChanged, rediscovered: s.rediscovered, portsChanged: s.portsChanged }))
      .catch((e) => console.error("[registry-sync]", e.message));
    schedule(state.intervalSec * 1000);
  }, delayMs);
}

export function registrySyncStatus() {
  return {
    configured: registryConfigured(),
    intervalSec: state.intervalSec,
    running: !!state.running,
    lastRunAt: state.lastRunAt, lastOk: state.lastOk, lastError: state.lastError, lastSummary: state.lastSummary,
    nextRunAt: state.nextRunAt,
    min: SYNC_INTERVAL_MIN, max: SYNC_INTERVAL_MAX,
  };
}

/** Changes the interval (0 = off), saves it and reschedules: the next run is one new interval from now. */
export async function setRegistrySyncInterval(sec: number) {
  if (sec !== 0 && (sec < SYNC_INTERVAL_MIN || sec > SYNC_INTERVAL_MAX)) throw new Error(`interval must be 0 or ${SYNC_INTERVAL_MIN}-${SYNC_INTERVAL_MAX} s`);
  await prisma.setting.upsert({ where: { key: SYNC_INTERVAL_KEY }, create: { key: SYNC_INTERVAL_KEY, value: String(sec) }, update: { value: String(sec) } });
  state.intervalSec = sec;
  schedule(sec * 1000);
  return registrySyncStatus();
}

export async function startRegistrySyncScheduler() {
  if (!registryConfigured()) return;
  const saved = await prisma.setting.findUnique({ where: { key: SYNC_INTERVAL_KEY } }).catch(() => null);
  const n = saved ? Number(saved.value) : NaN;
  state.intervalSec = Number.isFinite(n) ? n : env.registrySyncInterval;
  schedule(15000); // first run shortly after start
}
