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
};

if (env.appSecret.length < 32) {
  console.warn("[env] APP_SECRET is shorter than 32 characters; use a longer random secret in production.");
}
