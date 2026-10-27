import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";

export const locationRoutes = new Elysia({ prefix: "/locations" })
  .use(authGuard)
  /** Floors with rooms and camera counts — drives the Live sidebar. */
  .get("/tree", async () => {
    const floors = await prisma.floor.findMany({
      orderBy: { sortOrder: "asc" },
      include: {
        rooms: { orderBy: { code: "asc" }, include: { _count: { select: { cameras: true } } } },
        _count: { select: { cameras: true } },
      },
    });
    return floors.map((f) => ({
      id: f.id,
      code: f.code,
      name: f.name,
      cameraCount: f._count.cameras,
      rooms: f.rooms.map((r) => ({ id: r.id, code: r.code, name: r.name, cameraCount: r._count.cameras })),
    }));
  })
  .post(
    "/floors",
    async ({ user, body }) => {
      requireRole(user, "ADMIN");
      return prisma.floor.create({ data: body });
    },
    { body: t.Object({ code: t.String(), name: t.String(), sortOrder: t.Optional(t.Integer()) }) },
  )
  .patch(
    "/floors/:id",
    async ({ user, params, body }) => {
      requireRole(user, "ADMIN");
      return prisma.floor.update({ where: { id: Number(params.id) }, data: body });
    },
    { body: t.Object({ name: t.Optional(t.String()), sortOrder: t.Optional(t.Integer()) }) },
  )
  .post(
    "/rooms",
    async ({ user, body }) => {
      requireRole(user, "ADMIN");
      return prisma.room.create({ data: body });
    },
    { body: t.Object({ floorId: t.Integer(), code: t.String(), name: t.String() }) },
  )
  .patch(
    "/rooms/:id",
    async ({ user, params, body }) => {
      requireRole(user, "ADMIN");
      return prisma.room.update({ where: { id: Number(params.id) }, data: body });
    },
    { body: t.Object({ name: t.Optional(t.String()), floorId: t.Optional(t.Integer()) }) },
  );
