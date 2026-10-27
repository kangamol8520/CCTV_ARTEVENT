import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { jwtPlugin, authGuard, requireRole } from "../lib/auth.ts";
import { HttpError } from "../lib/errors.ts";
import { audit } from "../lib/audit.ts";

export const authRoutes = new Elysia({ prefix: "/auth" })
  .use(jwtPlugin)
  .post(
    "/login",
    async ({ body, jwt }) => {
      const user = await prisma.user.findUnique({ where: { username: body.username } });
      if (!user || !user.isActive || !(await Bun.password.verify(body.password, user.passwordHash))) {
        throw new HttpError(401, "Invalid username or password");
      }
      const token = await jwt.sign({ sub: String(user.id), role: user.role });
      await audit(user.id, "LOGIN", "User", user.id);
      return { token, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } };
    },
    { body: t.Object({ username: t.String({ minLength: 1 }), password: t.String({ minLength: 1 }) }) },
  )
  .use(authGuard)
  .get("/me", ({ user }) => user)
  .get("/users", async ({ user }) => {
    requireRole(user, "ADMIN");
    return prisma.user.findMany({ select: { id: true, username: true, displayName: true, role: true, isActive: true, createdAt: true }, orderBy: { id: "asc" } });
  })
  .post(
    "/users",
    async ({ user, body }) => {
      requireRole(user, "ADMIN");
      const created = await prisma.user.create({
        data: { username: body.username, displayName: body.displayName, role: body.role, passwordHash: await Bun.password.hash(body.password) },
        select: { id: true, username: true, displayName: true, role: true, isActive: true },
      });
      await audit(user.id, "CREATE", "User", created.id, { username: body.username, role: body.role });
      return created;
    },
    {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 64 }),
        password: t.String({ minLength: 8 }),
        displayName: t.String({ minLength: 1 }),
        role: t.Union([t.Literal("ADMIN"), t.Literal("OPERATOR"), t.Literal("VIEWER")]),
      }),
    },
  )
  .patch(
    "/users/:id",
    async ({ user, params, body }) => {
      requireRole(user, "ADMIN");
      const id = Number(params.id);
      const data: Record<string, unknown> = {};
      if (body.displayName !== undefined) data.displayName = body.displayName;
      if (body.role !== undefined) data.role = body.role;
      if (body.isActive !== undefined) data.isActive = body.isActive;
      if (body.password) data.passwordHash = await Bun.password.hash(body.password);
      const updated = await prisma.user.update({ where: { id }, data, select: { id: true, username: true, displayName: true, role: true, isActive: true } });
      await audit(user.id, "UPDATE", "User", id, { ...body, password: body.password ? "***" : undefined });
      return updated;
    },
    {
      body: t.Object({
        displayName: t.Optional(t.String()),
        role: t.Optional(t.Union([t.Literal("ADMIN"), t.Literal("OPERATOR"), t.Literal("VIEWER")])),
        isActive: t.Optional(t.Boolean()),
        password: t.Optional(t.String({ minLength: 8 })),
      }),
    },
  );
