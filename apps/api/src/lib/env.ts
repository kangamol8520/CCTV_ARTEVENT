import { resolve } from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  appSecret: required("APP_SECRET"),
  go2rtcUrl: (process.env.GO2RTC_URL ?? "http://localhost:1984").replace(/\/$/, ""),
  go2rtcPublicUrl: (process.env.GO2RTC_PUBLIC_URL ?? process.env.GO2RTC_URL ?? "http://localhost:1984").replace(/\/$/, ""),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()),
  seedAdminUsername: process.env.SEED_ADMIN_USERNAME ?? "admin",
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? "admin1234",
  healthCheckInterval: Number(process.env.HEALTH_CHECK_INTERVAL ?? 300),
  registryApiUrl: (process.env.REGISTRY_API_URL ?? "").replace(/\/$/, ""),
  registrySyncInterval: Number(process.env.REGISTRY_SYNC_INTERVAL ?? 0),
  registryCaFile: process.env.REGISTRY_CA_FILE ?? "",
  registryJobType: process.env.REGISTRY_JOBTYPE ?? "01",
  registryCategory: process.env.REGISTRY_CATEGORY ?? "A003",
  /** Central recording (Phase 2). Default: <repo>/data/recordings (git-ignored). */
  recordingsDir: resolve(process.env.RECORDINGS_DIR ?? resolve(import.meta.dir, "../../../../data/recordings")),
  recordingSegmentSeconds: Number(process.env.RECORDING_SEGMENT_SECONDS ?? 60),
  recordingRetentionDays: Number(process.env.RECORDING_RETENTION_DAYS ?? 3),
  /** Oldest files are deleted early when free space on the recordings disk drops below this. */
  recordingMinFreeGb: Number(process.env.RECORDING_MIN_FREE_GB ?? 50),
  /** RTSP base of go2rtc as seen by the recorder (records the restream, so cameras get no extra connection). */
  go2rtcRtspUrl: (process.env.GO2RTC_RTSP_URL ?? "rtsp://127.0.0.1:8554").replace(/\/$/, ""),
  /** Face entry/exit log (Phase 3): worker output (gallery, event snapshots). Default <repo>/data/face. */
  faceDataDir: resolve(process.env.FACE_DATA_DIR ?? resolve(import.meta.dir, "../../../../data/face")),
  /** Employee master (Emp.json + photos/) — personal data, never in git. Default <repo>/data/employees. */
  employeesDir: resolve(process.env.EMPLOYEES_DIR ?? resolve(import.meta.dir, "../../../../data/employees")),
};

if (env.appSecret.length < 32) {
  console.warn("[env] APP_SECRET is shorter than 32 characters; use a longer random secret in production.");
}
