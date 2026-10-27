/** Periodic reachability check (TCP connect to RTSP / HTTP port) for cameras and NVRs. */
import { prisma } from "../lib/prisma.ts";
import { env } from "../lib/env.ts";

export function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          clearTimeout(timer);
          socket.end();
          finish(true);
        },
        data() {},
        error() {
          clearTimeout(timer);
          finish(false);
        },
        close() {},
        connectError() {
          clearTimeout(timer);
          finish(false);
        },
      },
    }).catch(() => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

async function runWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runHealthCheck() {
  const now = new Date();
  const nvrs = await prisma.nvr.findMany();
  await runWithLimit(nvrs, 10, async (n) => {
    const ok = await tcpProbe(n.host, n.rtspPort);
    await prisma.nvr.update({ where: { id: n.id }, data: { status: ok ? "ONLINE" : "OFFLINE", ...(ok ? { lastSeenAt: now } : {}) } });
  });
  const cams = await prisma.camera.findMany({ where: { isEnabled: true }, include: { nvr: true } });
  await runWithLimit(cams, 20, async (c) => {
    let ok: boolean;
    if (c.protocol === "NVR_CHANNEL") ok = c.nvr ? c.nvr.status === "ONLINE" || (await tcpProbe(c.nvr.host, c.nvr.rtspPort)) : false;
    else if (c.host) ok = await tcpProbe(c.host, c.rtspPort);
    else ok = false;
    await prisma.camera.update({ where: { id: c.id }, data: { status: ok ? "ONLINE" : "OFFLINE", ...(ok ? { lastSeenAt: now } : {}) } });
  });
  return { checkedAt: now, nvrs: nvrs.length, cameras: cams.length };
}

export function startHealthScheduler() {
  if (!env.healthCheckInterval) return;
  const tick = () => runHealthCheck().then((r) => console.log("[health]", r)).catch((e) => console.error("[health]", e));
  setTimeout(tick, 5000);
  setInterval(tick, env.healthCheckInterval * 1000);
}
