import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";
import { notFound, badRequest } from "../lib/errors.ts";
import { audit } from "../lib/audit.ts";
import { registryConfigured, getRegistryDetail, getRegistryRepairs, editRegistryDevice } from "../services/registry.ts";
import { syncFromRegistry } from "../services/registry-sync.ts";
import { applyDiscovery } from "../services/discovery.ts";
import { syncCamera } from "../services/go2rtc.ts";

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const dateStr = (v: unknown) => { const d = v ? new Date(String(v)) : null; return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : ""; };

export const registryRoutes = new Elysia({ prefix: "/registry" })
  .use(authGuard)
  .get("/status", () => ({ configured: registryConfigured() }))
  .post(
    "/sync",
    async ({ user, query }) => {
      requireRole(user, "OPERATOR");
      return syncFromRegistry({ rediscover: query.rediscover !== "false", userId: user.id });
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
  /** Edit the registry device (write-back). Never deletes. Sends the full record (current
   *  values merged with the patch) because the backend UPDATEs every column. */
  .put(
    "/cameras/:cameraId",
    async ({ user, params, body }) => {
      requireRole(user, "OPERATOR");
      const cam = await prisma.camera.findUnique({ where: { id: Number(params.cameraId) } });
      if (!cam?.registryId) throw badRequest("Camera is not linked to the registry");
      const detail = await getRegistryDetail(cam.registryId);
      const cur = (detail.dataDevice ?? {}) as Record<string, unknown>;
      const record = {
        JobTypeCode: str(cur.JobTypeCode) || "01",
        CategoryCode: str(cur.CategoryCode) || "A003",
        DeviceNo: str(cur.DeviceNo) || cam.deviceNo,
        FloorCode: body.FloorCode ?? str(cur.FloorCode),
        RoomCode: body.RoomCode ?? str(cur.RoomCode),
        PurchaseDate: dateStr(cur.PurchaseDate),
        OutWarranty: dateStr(cur.OutWarranty),
        Owner: str(cur.Owner),
        Desciption: body.Desciption ?? str(cur.Desciption),
        Status1: body.Status1 ?? (str(cur.Status1) || "0"),
        IPv4_1: body.IPv4_1 ?? str(cur.IPv4_1),
        IPv4_2: body.IPv4_2 ?? str(cur.IPv4_2),
      };
      await editRegistryDevice(cam.registryId, record);
      await audit(user.id, "EDIT", "Registry", cam.registryId, { deviceNo: cam.deviceNo, patch: body });

      // Reflect the change locally and re-discover if the IP changed.
      const newHost = /^\d{1,3}(\.\d{1,3}){3}$/.test(record.IPv4_1.split(":")[0] ?? "") ? record.IPv4_1.split(":")[0]! : null;
      const data: Record<string, unknown> = { description: record.Desciption };
      const ipChanged = newHost && newHost !== cam.host;
      if (newHost) data.host = newHost;
      await prisma.camera.update({ where: { id: cam.id }, data });
      if (ipChanged) { await applyDiscovery(cam.id).catch(() => {}); } else { await syncCamera(cam.id).catch(() => {}); }
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
      }),
    },
  );
