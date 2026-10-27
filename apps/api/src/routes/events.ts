import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { notFound } from "../lib/errors.ts";

const eventInclude = {
  camera: { select: { id: true, deviceNo: true, name: true, floor: { select: { name: true } }, room: { select: { name: true } } } },
  createdBy: { select: { id: true, displayName: true } },
  acknowledgedBy: { select: { id: true, displayName: true } },
} as const;

export function eventWhere(q: { from?: string; to?: string; cameraId?: string; type?: string; severity?: string; source?: string; floorId?: string }) {
  const where: Record<string, unknown> = {};
  if (q.from || q.to) where.startedAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
  if (q.cameraId) where.cameraId = Number(q.cameraId);
  if (q.type) where.type = q.type;
  if (q.severity) where.severity = q.severity;
  if (q.source) where.source = q.source;
  if (q.floorId) where.camera = { floorId: Number(q.floorId) };
  return where;
}

const eventQuery = t.Object({
  from: t.Optional(t.String()), to: t.Optional(t.String()), cameraId: t.Optional(t.String()), type: t.Optional(t.String()),
  severity: t.Optional(t.String()), source: t.Optional(t.String()), floorId: t.Optional(t.String()),
  page: t.Optional(t.String()), pageSize: t.Optional(t.String()),
});

export const eventRoutes = new Elysia({ prefix: "/events" })
  .use(authGuard)
  .get(
    "/",
    async ({ query }) => {
      const page = Math.max(1, Number(query.page ?? 1));
      const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 50)));
      const where = eventWhere(query);
      const [total, items] = await Promise.all([
        prisma.event.count({ where }),
        prisma.event.findMany({ where, include: eventInclude, orderBy: { startedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      ]);
      return { total, page, pageSize, items };
    },
    { query: eventQuery },
  )
  .get("/summary", async ({ query }) => {
    const where = eventWhere(query);
    const [byType, bySeverity, byCamera] = await Promise.all([
      prisma.event.groupBy({ by: ["type"], where, _count: { _all: true } }),
      prisma.event.groupBy({ by: ["severity"], where, _count: { _all: true } }),
      prisma.event.groupBy({ by: ["cameraId"], where, _count: { _all: true }, orderBy: { _count: { cameraId: "desc" } }, take: 10 }),
    ]);
    const camIds = byCamera.map((c) => c.cameraId).filter((v): v is number => v !== null);
    const cams = await prisma.camera.findMany({ where: { id: { in: camIds } }, select: { id: true, deviceNo: true, name: true } });
    return {
      byType: byType.map((r) => ({ type: r.type, count: r._count._all })),
      bySeverity: bySeverity.map((r) => ({ severity: r.severity, count: r._count._all })),
      topCameras: byCamera.map((r) => ({ camera: cams.find((c) => c.id === r.cameraId) ?? null, count: r._count._all })),
    };
  }, { query: eventQuery })
  .get("/:id", async ({ params }) => {
    const ev = await prisma.event.findUnique({ where: { id: Number(params.id) }, include: eventInclude });
    if (!ev) throw notFound("Event");
    return ev;
  })
  .post(
    "/",
    async ({ user, body }) => {
      requireRole(user, "OPERATOR");
      const ev = await prisma.event.create({
        data: { ...body, startedAt: new Date(body.startedAt), endedAt: body.endedAt ? new Date(body.endedAt) : null, source: "MANUAL", createdById: user.id },
        include: eventInclude,
      });
      await audit(user.id, "CREATE", "Event", ev.id, { title: body.title, cameraId: body.cameraId });
      return ev;
    },
    {
      body: t.Object({
        cameraId: t.Optional(t.Nullable(t.Integer())),
        type: t.Optional(t.String()),
        severity: t.Optional(t.String()),
        title: t.String({ minLength: 1 }),
        description: t.Optional(t.Nullable(t.String())),
        startedAt: t.String(),
        endedAt: t.Optional(t.Nullable(t.String())),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ user, params, body }) => {
      requireRole(user, "OPERATOR");
      const id = Number(params.id);
      const data: Record<string, unknown> = { ...body };
      if (body.startedAt) data.startedAt = new Date(body.startedAt);
      if (body.endedAt !== undefined) data.endedAt = body.endedAt ? new Date(body.endedAt) : null;
      const ev = await prisma.event.update({ where: { id }, data, include: eventInclude });
      await audit(user.id, "UPDATE", "Event", id, body);
      return ev;
    },
    {
      body: t.Object({
        cameraId: t.Optional(t.Nullable(t.Integer())),
        type: t.Optional(t.String()),
        severity: t.Optional(t.String()),
        title: t.Optional(t.String({ minLength: 1 })),
        description: t.Optional(t.Nullable(t.String())),
        startedAt: t.Optional(t.String()),
        endedAt: t.Optional(t.Nullable(t.String())),
      }),
    },
  )
  .post("/:id/acknowledge", async ({ user, params }) => {
    requireRole(user, "OPERATOR");
    const id = Number(params.id);
    const ev = await prisma.event.update({ where: { id }, data: { acknowledgedAt: new Date(), acknowledgedById: user.id }, include: eventInclude });
    await audit(user.id, "ACK", "Event", id);
    return ev;
  })
  .delete("/:id", async ({ user, params }) => {
    requireRole(user, "ADMIN");
    const id = Number(params.id);
    await prisma.event.delete({ where: { id } });
    await audit(user.id, "DELETE", "Event", id);
    return { ok: true };
  });
