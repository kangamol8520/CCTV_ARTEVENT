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

async function probeRetry(host: string, port: number): Promise<boolean> {
  if (await tcpProbe(host, port, 3000)) return true;
  await Bun.sleep(250);
  return tcpProbe(host, port, 4000);
}

/** "Online" means the device answers on EITHER its RTSP port or its HTTP port (with a retry).
 *  Checking only RTSP 554 wrongly flapped working cameras to OFFLINE under load — devices that
 *  the browser can still open on HTTP. Each probe retries before giving up. */
async function reachable(host: string, rtspPort: number, httpPort?: number): Promise<boolean> {
  if (await probeRetry(host, rtspPort)) return true;
  if (httpPort && httpPort !== rtspPort && (await probeRetry(host, httpPort))) return true;
  return false;
}

export async function runHealthCheck() {
  const now = new Date();
  const nvrs = await prisma.nvr.findMany();
  await runWithLimit(nvrs, 6, async (n) => {
    const ok = await reachable(n.host, n.rtspPort, n.httpPort);
    await prisma.nvr.update({ where: { id: n.id }, data: { status: ok ? "ONLINE" : "OFFLINE", ...(ok ? { lastSeenAt: now } : {}) } });
  });
  const cams = await prisma.camera.findMany({ where: { isEnabled: true }, include: { nvr: true } });
  await runWithLimit(cams, 6, async (c) => {
    let ok: boolean;
    if (c.protocol === "NVR_CHANNEL") ok = c.nvr ? c.nvr.status === "ONLINE" || (await reachable(c.nvr.host, c.nvr.rtspPort, c.nvr.httpPort)) : false;
    else if (c.host) ok = await reachable(c.host, c.rtspPort, c.httpPort);
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
