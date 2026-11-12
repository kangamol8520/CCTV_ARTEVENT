import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { env } from "./lib/env.ts";
import { HttpError } from "./lib/errors.ts";
import { seedAdmin } from "./lib/auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { locationRoutes } from "./routes/locations.ts";
import { nvrRoutes } from "./routes/nvrs.ts";
import { cameraRoutes } from "./routes/cameras.ts";
import { groupRoutes } from "./routes/groups.ts";
import { eventRoutes } from "./routes/events.ts";
import { playbackRoutes } from "./routes/playback.ts";
import { reportRoutes } from "./routes/reports.ts";
import { systemRoutes } from "./routes/system.ts";
import { layoutRoutes } from "./routes/layouts.ts";
import { registryRoutes } from "./routes/registry.ts";
import { recordingMediaRoutes, recordingRoutes } from "./routes/recordings.ts";
import { faceMediaRoutes, faceRoutes, faceWorkerRoutes } from "./routes/face.ts";
import { attendanceRoutes, attendanceWorkerRoutes } from "./routes/attendance.ts";
import { startRegistrySyncScheduler } from "./services/registry-sync.ts";
import { syncAllCameras, isReachable } from "./services/go2rtc.ts";
import { startHealthScheduler } from "./services/health.ts";

export const app = new Elysia()
  .use(cors({ origin: env.corsOrigins }))
  .use(swagger({ path: "/docs", documentation: { info: { title: "CCTV Platform API", version: "0.1.0" } } }))
  .onError(({ error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { error: error.message };
    }
    const code = (error as { code?: string }).code;
    if (code === "P2002") {
      set.status = 409;
      return { error: "Duplicate value violates a unique constraint" };
    }
    if (code === "P2025") {
      set.status = 404;
      return { error: "Record not found" };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { error: "Validation failed", detail: (error as Error).message };
    }
    console.error(error);
    set.status = 500;
    return { error: (error as Error).message ?? "Internal error" };
  })
  .get("/", () => ({ name: "cctv-platform-api", version: "0.1.0" }))
  .get("/health", () => ({ ok: true, time: new Date().toISOString() }))
  .group("/api", (g) =>
    g.use(recordingMediaRoutes).use(faceMediaRoutes).use(faceWorkerRoutes).use(attendanceWorkerRoutes).use(authRoutes).use(locationRoutes).use(nvrRoutes).use(cameraRoutes).use(groupRoutes).use(eventRoutes).use(playbackRoutes).use(reportRoutes).use(systemRoutes).use(layoutRoutes).use(registryRoutes).use(recordingRoutes).use(faceRoutes).use(attendanceRoutes),
  );

if (import.meta.main) {
  // At boot the API can start before the MSSQL container accepts connections. Wait for it instead of
  // crashing: under `bun --watch` a crash leaves the process alive but not listening, so systemd
  // never restarts it.
  for (let attempt = 1; ; attempt++) {
    try {
      await seedAdmin();
      break;
    } catch (e) {
      if (attempt === 1 || attempt % 12 === 0) console.warn(`[api] database not ready (attempt ${attempt}), retrying every 5 s:`, (e as Error).message.split("\n").pop());
      await Bun.sleep(5000);
    }
  }
  app.listen(env.port);
  console.log(`[api] listening on http://localhost:${env.port}  (docs at /docs)`);
  if (await isReachable()) {
    syncAllCameras().then((r) => console.log("[go2rtc] synced", { total: r.total, synced: r.synced, skipped: r.skipped.length })).catch((e) => console.error("[go2rtc]", e));
  } else {
    console.warn(`[go2rtc] not reachable at ${env.go2rtcUrl}; live streams will not be registered until it is up (POST /api/system/sync-streams)`);
  }
  startHealthScheduler();
  startRegistrySyncScheduler().catch((e) => console.error("[registry-sync] scheduler", e));
}

export type App = typeof app;
