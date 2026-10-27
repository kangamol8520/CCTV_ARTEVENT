import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";
import { encryptSecret } from "../lib/crypto.ts";
import { audit } from "../lib/audit.ts";
import { notFound } from "../lib/errors.ts";
import { tcpProbe } from "../services/health.ts";

const nvrSelect = {
  id: true, name: true, legacyDeviceNo: true, brand: true, model: true, serialNo: true, host: true, httpPort: true, rtspPort: true,
  username: true, maxChannels: true, channelMainPath: true, channelSubPath: true, playbackPath: true, status: true, lastSeenAt: true,
  notes: true, floorId: true, roomId: true, createdAt: true, updatedAt: true, _count: { select: { cameras: true } },
} as const;

const nvrBody = t.Object({
  name: t.String({ minLength: 1 }),
  legacyDeviceNo: t.Optional(t.Nullable(t.String())),
  brand: t.Optional(t.String()),
  model: t.Optional(t.Nullable(t.String())),
  serialNo: t.Optional(t.Nullable(t.String())),
  host: t.String({ minLength: 1 }),
  httpPort: t.Optional(t.Integer()),
  rtspPort: t.Optional(t.Integer()),
  username: t.Optional(t.Nullable(t.String())),
  password: t.Optional(t.Nullable(t.String())),
  maxChannels: t.Optional(t.Integer()),
  channelMainPath: t.Optional(t.String()),
  channelSubPath: t.Optional(t.String()),
  playbackPath: t.Optional(t.String()),
  notes: t.Optional(t.Nullable(t.String())),
  floorId: t.Optional(t.Nullable(t.Integer())),
  roomId: t.Optional(t.Nullable(t.Integer())),
});

export const nvrRoutes = new Elysia({ prefix: "/nvrs" })
  .use(authGuard)
  .get("/", () => prisma.nvr.findMany({ select: nvrSelect, orderBy: { name: "asc" } }))
  .get("/:id", async ({ params }) => {
    const nvr = await prisma.nvr.findUnique({ where: { id: Number(params.id) }, select: { ...nvrSelect, cameras: { select: { id: true, deviceNo: true, name: true, nvrChannel: true, status: true }, orderBy: { nvrChannel: "asc" } } } });
    if (!nvr) throw notFound("NVR");
    return nvr;
  })
  .post(
    "/",
    async ({ user, body }) => {
      requireRole(user, "ADMIN");
      const { password, ...rest } = body;
      const created = await prisma.nvr.create({ data: { ...rest, passwordEnc: password ? await encryptSecret(password) : null }, select: nvrSelect });
      await audit(user.id, "CREATE", "Nvr", created.id, { name: body.name, host: body.host });
      return created;
    },
    { body: nvrBody },
  )
  .patch(
    "/:id",
    async ({ user, params, body }) => {
      requireRole(user, "ADMIN");
      const { password, ...rest } = body;
      const data: Record<string, unknown> = { ...rest };
      if (password) data.passwordEnc = await encryptSecret(password);
      const updated = await prisma.nvr.update({ where: { id: Number(params.id) }, data, select: nvrSelect });
      await audit(user.id, "UPDATE", "Nvr", updated.id, { ...rest });
      return updated;
    },
    { body: t.Partial(nvrBody) },
  )
  .delete("/:id", async ({ user, params }) => {
    requireRole(user, "ADMIN");
    const id = Number(params.id);
    const inUse = await prisma.camera.count({ where: { nvrId: id } });
    if (inUse) throw new Error(`NVR still referenced by ${inUse} cameras`);
    await prisma.nvr.delete({ where: { id } });
    await audit(user.id, "DELETE", "Nvr", id);
    return { ok: true };
  })
  .post("/:id/probe", async ({ params }) => {
    const nvr = await prisma.nvr.findUnique({ where: { id: Number(params.id) } });
    if (!nvr) throw notFound("NVR");
    const [rtsp, http] = await Promise.all([tcpProbe(nvr.host, nvr.rtspPort), tcpProbe(nvr.host, nvr.httpPort)]);
    await prisma.nvr.update({ where: { id: nvr.id }, data: { status: rtsp ? "ONLINE" : "OFFLINE", ...(rtsp ? { lastSeenAt: new Date() } : {}) } });
    return { rtsp, http };
  });
