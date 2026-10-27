/**
 * Bulk CLI around services/discovery.ts.
 *   bun run scripts/discover-onvif.ts --host 192.168.20.183 [--apply]
 *   bun run scripts/discover-onvif.ts [--apply] [--all] [--onvif-only] [--limit N] [--concurrency N]
 */
import { prisma } from "../src/lib/prisma.ts";
import { encryptSecret } from "../src/lib/crypto.ts";
import { syncCamera } from "../src/services/go2rtc.ts";
import { discover, loadPasswords } from "../src/services/discovery.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onvifOnly = args.includes("--onvif-only");
const singleHost = args.includes("--host") ? args[args.indexOf("--host") + 1] : null;
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const concurrency = args.includes("--concurrency") ? Number(args[args.indexOf("--concurrency") + 1]) : 6;

async function runPool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

async function main() {
  const pws = loadPasswords();
  if (!pws.length) { console.error("no CAM_PASSWORD_* in .env"); process.exit(2); }

  let cams;
  if (singleHost) {
    cams = await prisma.camera.findMany({ where: { host: singleHost } });
  } else {
    const where = args.includes("--all")
      ? { isEnabled: true, host: { not: null }, protocol: { in: ["ONVIF", "RTSP"] } }
      : { isEnabled: true, host: { not: null }, OR: [{ protocol: "ONVIF" }, { protocol: "RTSP", mainStreamPath: null }] };
    cams = await prisma.camera.findMany({ where, orderBy: { id: "asc" }, take: Number.isFinite(limit) ? limit : undefined });
  }
  const targets = singleHost && !cams.length ? [{ id: 0, deviceNo: "(probe)", host: singleHost, httpPort: 80 } as any] : cams;
  console.log(`[discover] ${targets.length} target(s); apply=${apply}; passwords=${pws.length}`);
  const found: string[] = [], miss: string[] = [];

  await runPool(targets, singleHost ? 1 : concurrency, async (cam) => {
    const res = await discover(cam.host!, cam.httpPort ?? 80, pws, { onvifOnly });
    if (!res) { miss.push(cam.deviceNo); console.log(`  ✗ ${cam.deviceNo} (${cam.host}) — no ONVIF port and no known RTSP path`); return; }
    const mask = (s: string) => s.replace(/password=[^&]*/i, "password=***");
    console.log(`  ✓ ${cam.deviceNo} (${cam.host}) via ${res.via}: main=${mask(res.main)} sub=${res.sub === res.main ? "(=main)" : mask(res.sub)} pw#${res.pwIndex + 1} rtspPort=${res.rtspPort}`);
    found.push(cam.deviceNo);
    if (apply && cam.id) {
      await prisma.camera.update({ where: { id: cam.id }, data: { protocol: "RTSP", rtspPort: res.rtspPort, httpPort: res.httpPort, mainStreamPath: res.main, subStreamPath: res.sub, username: "admin", passwordEnc: await encryptSecret(pws[res.pwIndex]!), status: "ONLINE", lastSeenAt: new Date(), importFlags: null } });
      await syncCamera(cam.id).catch(() => {});
    }
  });

  console.log(`[discover] done. found: ${found.length}, missed: ${miss.length}${apply ? " (applied)" : " (dry run — add --apply to save)"}`);
  if (miss.length) console.log(`[discover] missed: ${miss.slice(0, 40).join(", ")}${miss.length > 40 ? " …" : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
