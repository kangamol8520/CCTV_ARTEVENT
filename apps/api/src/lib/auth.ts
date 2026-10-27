import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { env } from "./env.ts";
import { prisma } from "./prisma.ts";
import { HttpError } from "./errors.ts";

export type Role = "ADMIN" | "OPERATOR" | "VIEWER";
const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
}

export const jwtPlugin = jwt({ name: "jwt", secret: env.appSecret, exp: "12h" });

/** Adds `user` (or throws 401) to every handler mounted after it. */
export const authGuard = new Elysia({ name: "auth-guard" })
  .use(jwtPlugin)
  .derive({ as: "scoped" }, async ({ jwt, headers }) => {
    const h = headers["authorization"] ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) throw new HttpError(401, "Missing bearer token");
    const payload = (await jwt.verify(token)) as false | { sub?: string | number };
    if (!payload || payload.sub === undefined) throw new HttpError(401, "Invalid token");
    const user = await prisma.user.findUnique({ where: { id: Number(payload.sub) } });
    if (!user || !user.isActive) throw new HttpError(401, "User disabled");
    const authUser: AuthUser = { id: user.id, username: user.username, displayName: user.displayName, role: user.role as Role };
    return { user: authUser };
  });

export function requireRole(user: AuthUser, min: Role) {
  if (RANK[user.role] < RANK[min]) throw new HttpError(403, `Requires role ${min}`);
}

export async function seedAdmin() {
  const count = await prisma.user.count();
  if (count > 0) return;
  await prisma.user.create({
    data: {
      username: env.seedAdminUsername,
      passwordHash: await Bun.password.hash(env.seedAdminPassword),
      displayName: "Administrator",
      role: "ADMIN",
    },
  });
  console.log(`[auth] seeded admin user "${env.seedAdminUsername}"`);
}
