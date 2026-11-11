import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";
import { notFound, badRequest } from "../lib/errors.ts";
import { audit } from "../lib/audit.ts";
import { registryConfigured, getRegistryDetail, getRegistryRepairs, patchRegistryDevice, insertRepairDoc, openRepairs } from "../services/registry.ts";
import { employees } from "../services/face.ts";
import { env } from "../lib/env.ts";
import { HttpError } from "../lib/errors.ts";
import { runRegistrySync, cameraPortsFromRegistry, pushCameraPorts, registrySyncStatus, setRegistrySyncInterval } from "../services/registry-sync.ts";
import { applyDiscovery } from "../services/discovery.ts";
import { syncCamera } from "../services/go2rtc.ts";

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export const registryRoutes = new Elysia({ prefix: "/registry" })
  .use(authGuard)
  .get("/status", () => ({ configured: registryConfigured() }))
  /** Auto-sync schedule: interval, last/next run. */
  .get("/sync-settings", () => registrySyncStatus())
  .put(
    "/sync-settings",
    async ({ user, body }) => {
      requireRole(user, "ADMIN");
      const r = await setRegistrySyncInterval(body.intervalSec).catch((e) => { throw badRequest((e as Error).message); });
      await audit(user.id, "UPDATE", "Setting", undefined, { registrySyncIntervalSec: body.intervalSec });
      return r;
    },
    { body: t.Object({ intervalSec: t.Integer({ minimum: 0, maximum: 86400 }) }) },
  )
  .post(
    "/sync",
    async ({ user, query }) => {
      requireRole(user, "OPERATOR");
      return runRegistrySync({ rediscover: query.rediscover !== "false", userId: user.id });
    },
    { query: t.Object({ rediscover: t.Optional(t.String()) }) },
  )
  /** Live registry record + logins for one CCTV camera (for the "ทะเบียน" tab / repair tickets). */
  .get("/cameras/:cameraId", async ({ params }) => {
    const cam = await prisma.camera.findUnique({ where: { id: Number(params.cameraId) } });
    if (!cam) throw notFound("Camera");
    if (!cam.registryId) return { linked: false, camera: { id: cam.id, deviceNo: cam.deviceNo } };
    const detail = await getRegistryDetail(cam.registryId);
    return { linked: true, registryId: cam.registryId, detail };
  })
  .get("/cameras/:cameraId/repairs", async ({ params }) => {
    const cam = await prisma.camera.findUnique({ where: { id: Number(params.cameraId) } });
    if (!cam?.registryId) throw badRequest("Camera is not linked to the registry");
    return getRegistryRepairs(cam.registryId);
  })
  /** Defaults for the repair form (dev: the configured reporter/tel; production: empty → user types). */
  .get("/repair-defaults", () => ({ contactPerson: env.repairContactPerson, tel: env.repairTel, maxBrokenDes: 190 }))
  /** Employee lookup for the reporter code (active staff from Emp.json + active.json). */
  .get("/employees/:code", async ({ params }) => {
    const emp = (await employees()).get(params.code.trim());
    return emp ? { code: emp.code, name: emp.name } : { code: params.code, name: null };
  })
  /** File a repair ticket (ใบแจ้งซ่อม) in webae for this camera. Floor/room come from the live
   *  registry record; an open ticket blocks a duplicate unless `force` is set. */
  .post(
    "/cameras/:cameraId/repairs",
    async ({ user, params, body }) => {
      requireRole(user, "OPERATOR");
      const cam = await prisma.camera.findUnique({ where: { id: Number(params.cameraId) } });
      if (!cam?.registryId) throw badRequest("กล้องนี้ยังไม่ผูกกับทะเบียน");
      const contactPerson = body.contactPerson.trim();
      const brokenDes = body.brokenDes.trim();
      if (!brokenDes) throw badRequest("กรุณาระบุอาการเสีย");
      if (brokenDes.length > 190) throw badRequest("อาการเสียยาวเกิน 190 ตัวอักษร");
      const dir = await employees();
      if (dir.size && !dir.has(contactPerson)) throw badRequest(`ไม่พบรหัสพนักงาน ${contactPerson} (หรือพ้นสภาพแล้ว)`);
      const open = await openRepairs(cam.registryId);
      if (open.length && !body.force) {
        throw new HttpError(409, `มีใบแจ้งซ่อมที่ยังไม่เสร็จอยู่แล้ว: ${open.map((r) => `${r.BillDoc} (${r.StatusName ?? r.Status})`).join(", ")}`);
      }
      const dd = ((await getRegistryDetail(cam.registryId)).dataDevice ?? {}) as Record<string, unknown>;
      const floorCode = str(dd.FloorCode);
      const roomCode = str(dd.RoomCode);
      if (!floorCode || !roomCode) throw badRequest("ทะเบียนไม่มีรหัสชั้น/ห้องของกล้องนี้");
      const date = body.dueDate ? new Date(body.dueDate) : new Date();
      const res = (await insertRepairDoc({
        deviceNo: str(dd.DeviceNo) || cam.deviceNo, floorCode, roomCode, brokenDes, date,
        contactPerson, tel: body.tel.trim(),
      })) as { result?: { BillID: number }[] };
      const billId = res.result?.[0]?.BillID ?? null;
      // The insert answer has only BillID; read the ticket back for its document number.
      const rows = (await getRegistryRepairs(cam.registryId).catch(() => [])) as { BillID?: number; BillDoc?: string }[];
      const billDoc = (Array.isArray(rows) ? rows : []).find((r) => r.BillID === billId)?.BillDoc ?? null;
      await audit(user.id, "REPAIR_REQUEST", "Registry", cam.registryId, { deviceNo: cam.deviceNo, billId, billDoc, contactPerson, brokenDes });
      return { ok: true, billId, billDoc };
    },
    {
      body: t.Object({
        contactPerson: t.String({ minLength: 1, maxLength: 20 }),
        tel: t.String({ maxLength: 30 }),
        brokenDes: t.String({ minLength: 1, maxLength: 300 }),
        dueDate: t.Optional(t.String()),
        force: t.Optional(t.Boolean()),
      }),
    },
  )
  /** Edit the registry device (write-back). Never deletes. The backend UPDATEs every legacy column,
   *  so patchRegistryDevice sends the full record (current values merged with the patch).
   *  PROTOCOL / Network_PORT / Physical_PORT are also applied to the camera here and now, so the
   *  stream reconnects immediately instead of waiting for the next registry sync. */
  .put(
    "/cameras/:cameraId",
    async ({ user, params, body }) => {
      requireRole(user, "OPERATOR");
      const cam = await prisma.camera.findUnique({ where: { id: Number(params.cameraId) } });
      if (!cam?.registryId) throw badRequest("Camera is not linked to the registry");
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) if (v !== undefined) patch[k] = k === "PROTOCOL" ? v.trim().toUpperCase() : v.trim();
      const local = cameraPortsFromRegistry(patch);
      if (patch.PROTOCOL && !local.protocol) throw badRequest("PROTOCOL ต้องเป็น HIKVISION, ONVIF, RTSP หรือ NVR_CHANNEL");
      if (patch.Network_PORT && !local.rtspPort) throw badRequest("Network_PORT ต้องเป็นเลขพอร์ต 1-65535");
      if (patch.Physical_PORT && !local.nvrChannel) throw badRequest("Physical_PORT ต้องเป็นเลขช่อง 1-256");
      if ((local.protocol ?? cam.protocol) === "NVR_CHANNEL" && !(local.nvrChannel ?? cam.nvrChannel) && patch.Physical_PORT !== undefined) {
        throw badRequest("กล้อง Plug&Play ต้องระบุ Physical_PORT");
      }
      const record = await patchRegistryDevice(cam.registryId, patch, cam.deviceNo);
      await audit(user.id, "EDIT", "Registry", cam.registryId, { deviceNo: cam.deviceNo, patch: body });

      // Reflect the change locally and re-discover if the IP changed.
      const newHost = /^\d{1,3}(\.\d{1,3}){3}$/.test(record.IPv4_1.split(":")[0] ?? "") ? record.IPv4_1.split(":")[0]! : null;
      const data: Record<string, unknown> = { description: record.Desciption, ...local };
      if (local.protocol === "NVR_CHANNEL" || (!local.protocol && cam.protocol === "NVR_CHANNEL")) {
        const nvrIp = record.IPv4_2.split(":")[0]?.trim();
        const nvr = nvrIp ? await prisma.nvr.findFirst({ where: { host: nvrIp } }) : null;
        if (nvr) data.nvrId = nvr.id;
      }
      const ipChanged = newHost && newHost !== cam.host;
      if (newHost) data.host = newHost;
      await prisma.camera.update({ where: { id: cam.id }, data });
      if (ipChanged) {
        const r = await applyDiscovery(cam.id).catch(() => ({ ok: false }));
        if (r.ok) await pushCameraPorts(cam.id);
      } else {
        await syncCamera(cam.id).catch(() => {});
      }
      return { ok: true, ipChanged: !!ipChanged };
    },
    {
      body: t.Object({
        IPv4_1: t.Optional(t.String()),
        IPv4_2: t.Optional(t.String()),
        Desciption: t.Optional(t.String()),
        FloorCode: t.Optional(t.String()),
        RoomCode: t.Optional(t.String()),
        Status1: t.Optional(t.String()),
        PROTOCOL: t.Optional(t.String({ maxLength: 20 })),
        Network_PORT: t.Optional(t.String({ maxLength: 10 })),
        Physical_PORT: t.Optional(t.String({ maxLength: 10 })),
      }),
    },
  );
