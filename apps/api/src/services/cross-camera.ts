/**
 * One walk through the door, seen by both face cameras.
 *
 * Direction is locked per camera (entrance camera = IN, exit camera = OUT), but someone walking out
 * can glance at the entrance camera on the way (and vice versa). When the same person is seen by
 * both cameras within PAIR_GAP_MS it is a single movement: keep the sighting where they clearly
 * walked towards the camera (face grows / moves down the frame) and delete the one where they did
 * not. If both — or neither — show a clear approach, both are kept (someone can turn back).
 *
 * Only MATCHED events take part (an UNCERTAIN name is not reliable enough to delete something).
 * Hand-reviewed events take part too: a review confirms who it is, not which way they walked.
 * Runs after scan-confirm, so events promoted to MATCHED by
 * a fingerprint scan are covered too.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { prisma } from "../lib/prisma.ts";
import { env } from "../lib/env.ts";

const PAIR_GAP_MS = 20_000;
const APPROACH_TRAVEL = 0.03; // moved down ≥ 3 % of the frame height …
const APPROACH_GROWTH = 1.1; // … or the face grew ≥ 10 %

type Ev = { id: number; cameraId: number; direction: string; confirmedBy: string | null; empCode: string | null; firstSeenAt: Date; lastSeenAt: Date; travelY: number | null; sizeGrowth: number | null; reviewedAt: Date | null; snapshotPath: string | null };
// an IN confirmed by the stairs camera (in-check.ts) is a proven entry, whatever its own motion says
const approaches = (e: Ev) => e.confirmedBy === "CAM" || (e.travelY ?? 0) > APPROACH_TRAVEL || (e.sizeGrowth ?? 1) > APPROACH_GROWTH;

export async function dedupeCrossCamera(since: Date, dryRun = false): Promise<{ checked: number; removed: number; ids: number[] }> {
  const evs: Ev[] = await prisma.accessEvent.findMany({
    where: { status: "MATCHED", empCode: { not: null }, travelY: { not: null }, firstSeenAt: { gte: since }, direction: { in: ["IN", "OUT"] } },
    orderBy: { firstSeenAt: "asc" },
    select: { id: true, cameraId: true, direction: true, confirmedBy: true, empCode: true, firstSeenAt: true, lastSeenAt: true, travelY: true, sizeGrowth: true, reviewedAt: true, snapshotPath: true },
  });
  const byEmp = new Map<string, Ev[]>();
  for (const e of evs) byEmp.set(e.empCode!, [...(byEmp.get(e.empCode!) ?? []), e]);

  const drop = new Map<number, Ev>();
  for (const list of byEmp.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        if (b.firstSeenAt.getTime() - a.lastSeenAt.getTime() > PAIR_GAP_MS) break;
        if (b.cameraId === a.cameraId || b.direction === a.direction) continue; // only an IN against an OUT
        const aOk = approaches(a), bOk = approaches(b);
        if (aOk === bOk) continue; // both clear or both unclear → keep both
        const weak = aOk ? b : a;
        drop.set(weak.id, weak);
      }
    }
  }
  const gone = [...drop.values()];
  const ids = gone.map((e) => e.id);
  if (!gone.length || dryRun) return { checked: evs.length, removed: dryRun ? 0 : gone.length, ids };

  await prisma.accessEvent.deleteMany({ where: { id: { in: ids } } });
  const root = resolve(env.faceDataDir);
  for (const e of gone) {
    if (!e.snapshotPath) continue;
    const p = resolve(join(root, e.snapshotPath));
    if (!p.startsWith(root + "/")) continue;
    if (await prisma.accessEvent.count({ where: { snapshotPath: e.snapshotPath } })) continue;
    try { if (existsSync(p)) unlinkSync(p); } catch { /* snapshot cleanup is best effort */ }
  }
  return { checked: evs.length, removed: gone.length, ids };
}
