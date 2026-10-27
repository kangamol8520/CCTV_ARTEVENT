import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { notFound } from "../lib/errors.ts";

/** config is stored as a JSON string; validated loosely so the editor can evolve freely. */
const layoutBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 128 }),
  description: t.Optional(t.Nullable(t.String())),
  config: t.Any(),
  isShared: t.Optional(t.Boolean()),
  sortOrder: t.Optional(t.Integer()),
});

function serialize(l: { config: string } & Record<string, unknown>) {
  let config: unknown = {};
  try { config = JSON.parse(l.config); } catch {}
  return { ...l, config };
}

export const layoutRoutes = new Elysia({ prefix: "/layouts" })
  .use(authGuard)
  .get("/", async () => {
    const layouts = await prisma.layout.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { createdBy: { select: { id: true, displayName: true } } },
    });
    return layouts.map(serialize);
  })
  .get("/:id", async ({ params }) => {
    const l = await prisma.layout.findUnique({ where: { id: Number(params.id) }, include: { createdBy: { select: { id: true, displayName: true } } } });
    if (!l) throw notFound("Layout");
    return serialize(l);
  })
  .post(
    "/",
    async ({ user, body }) => {
      requireRole(user, "OPERATOR");
      const l = await prisma.layout.create({
        data: {
          name: body.name,
          description: body.description ?? null,
          config: JSON.stringify(body.config ?? {}),
          isShared: body.isShared ?? true,
          sortOrder: body.sortOrder ?? 0,
          createdById: user.id,
        },
        include: { createdBy: { select: { id: true, displayName: true } } },
      });
      await audit(user.id, "CREATE", "Layout", l.id, { name: body.name });
      return serialize(l);
    },
    { body: layoutBody },
  )
  .put(
    "/:id",
    async ({ user, params, body }) => {
      requireRole(user, "OPERATOR");
      const id = Number(params.id);
      const data: Record<string, unknown> = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.description !== undefined) data.description = body.description;
      if (body.config !== undefined) data.config = JSON.stringify(body.config);
      if (body.isShared !== undefined) data.isShared = body.isShared;
      if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
      const l = await prisma.layout.update({ where: { id }, data, include: { createdBy: { select: { id: true, displayName: true } } } });
      await audit(user.id, "UPDATE", "Layout", id, { name: body.name });
      return serialize(l);
    },
    { body: t.Partial(layoutBody) },
  )
  .delete("/:id", async ({ user, params }) => {
    requireRole(user, "OPERATOR");
    const id = Number(params.id);
    await prisma.layout.delete({ where: { id } });
    await audit(user.id, "DELETE", "Layout", id);
    return { ok: true };
  });
