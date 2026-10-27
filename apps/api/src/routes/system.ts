import { Elysia } from "elysia";
import { prisma } from "../lib/prisma.ts";
import { authGuard, requireRole } from "../lib/auth.ts";
import { env } from "../lib/env.ts";
import { isReachable, listStreams, syncAllCameras } from "../services/go2rtc.ts";
import { runHealthCheck } from "../services/health.ts";

export const systemRoutes = new Elysia({ prefix: "/system" })
  .use(authGuard)
  .get("/status", async () => {
    const [cameras, online, nvrs, nvrOnline, go2rtc] = await Promise.all([
      prisma.camera.count({ where: { isEnabled: true } }),
      prisma.camera.count({ where: { isEnabled: true, status: "ONLINE" } }),
      prisma.nvr.count(),
      prisma.nvr.count({ where: { status: "ONLINE" } }),
      isReachable(),
    ]);
    let activeStreams = 0;
    let viewers = 0;
    if (go2rtc) {
      try {
        const streams = await listStreams();
        for (const s of Object.values(streams)) {
          if (s.producers?.length) activeStreams++;
          viewers += s.consumers?.length ?? 0;
        }
      } catch {}
    }
    return { cameras: { total: cameras, online }, nvrs: { total: nvrs, online: nvrOnline }, go2rtc: { reachable: go2rtc, publicUrl: env.go2rtcPublicUrl, activeStreams, viewers } };
  })
  .post("/sync-streams", async ({ user }) => {
    requireRole(user, "OPERATOR");
    return syncAllCameras();
  })
  .post("/health-check", async ({ user }) => {
    requireRole(user, "OPERATOR");
    return runHealthCheck();
  })
  .get("/audit", async ({ user, query }) => {
    requireRole(user, "ADMIN");
    const take = Math.min(500, Number((query as Record<string, string>).take ?? 100));
    return prisma.auditLog.findMany({ include: { user: { select: { username: true, displayName: true } } }, orderBy: { createdAt: "desc" }, take });
  });
