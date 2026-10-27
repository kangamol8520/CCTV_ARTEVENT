import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { notFound } from "../lib/errors.ts";

const groupInclude = {
  members: { orderBy: { sortOrder: "asc" as const }, include: { camera: { select: { id: true, deviceNo: true, name: true, status: true, isEnabled: true } } } },
};

export const groupRoutes = new Elysia({ prefix: "/groups" })
  .use(authGuard)
  .get("/", async () => {
    const groups = await prisma.cameraGroup.findMany({ orderBy: { sortOrder: "asc" }, include: groupInclude });
    return groups.map((g) => ({ ...g, members: g.members.map((m) => ({ sortOrder: m.sortOrder, ...m.camera })) }));
  })
  .get("/:id", async ({ params }) => {
    const g = await prisma.cameraGroup.findUnique({ where: { id: Number(params.id) }, include: groupInclude });
    if (!g) throw notFound("Group");
    return { ...g, members: g.members.map((m) => ({ sortOrder: m.sortOrder, ...m.camera })) };
  })
  .post(
    "/",
    async ({ user, body }) => {
      requireRole(user, "OPERATOR");
      const { cameraIds = [], ...rest } = body;
      const g = await prisma.cameraGroup.create({
        data: { ...rest, members: { create: cameraIds.map((cameraId, i) => ({ cameraId, sortOrder: i })) } },
        include: groupInclude,
      });
      await audit(user.id, "CREATE", "CameraGroup", g.id, { name: body.name, cameraIds });
      return g;
    },
    { body: t.Object({ name: t.String({ minLength: 1 }), description: t.Optional(t.Nullable(t.String())), gridColumns: t.Optional(t.Integer({ minimum: 1, maximum: 8 })), sortOrder: t.Optional(t.Integer()), cameraIds: t.Optional(t.Array(t.Integer())) }) },
  )
  .patch(
    "/:id",
    async ({ user, params, body }) => {
      requireRole(user, "OPERATOR");
      const id = Number(params.id);
      const { cameraIds, ...rest } = body;
      const g = await prisma.$transaction(async (tx) => {
        await tx.cameraGroup.update({ where: { id }, data: rest });
        if (cameraIds) {
          await tx.cameraGroupMember.deleteMany({ where: { groupId: id } });
          await tx.cameraGroupMember.createMany({ data: cameraIds.map((cameraId, i) => ({ groupId: id, cameraId, sortOrder: i })) });
        }
        return tx.cameraGroup.findUniqueOrThrow({ where: { id }, include: groupInclude });
      });
      await audit(user.id, "UPDATE", "CameraGroup", id, body);
      return g;
    },
    { body: t.Object({ name: t.Optional(t.String({ minLength: 1 })), description: t.Optional(t.Nullable(t.String())), gridColumns: t.Optional(t.Integer({ minimum: 1, maximum: 8 })), sortOrder: t.Optional(t.Integer()), cameraIds: t.Optional(t.Array(t.Integer())) }) },
  )
  .delete("/:id", async ({ user, params }) => {
    requireRole(user, "OPERATOR");
    const id = Number(params.id);
    await prisma.cameraGroup.delete({ where: { id } });
    await audit(user.id, "DELETE", "CameraGroup", id);
    return { ok: true };
  });
