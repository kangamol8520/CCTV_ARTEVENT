/**
 * Entry confirmation by a second camera (FL1-11, at the stairs behind the security gates).
 *
 * Cameras with faceDirection = "CHECK" record sightings with direction "CHECK". They never count as
 * an entry on their own (someone already inside can walk up the stairs); they only confirm an IN
 * from an entrance camera:
 *   - same person seen by the entrance camera, then by the check camera within the window
 *     → the two are one entry: the IN keeps the entrance time, gets confirmedBy "CAM" (unless it was
 *       already confirmed by a scan) and the best face of the two; the CHECK row is removed.
 *   - an UNCERTAIN IN whose suggestion the check camera also names → MATCHED (two independent views agree)
 *   - an UNCERTAIN IN whose candidates include the person the check camera MATCHED → that person.
 * Unconfirmed CHECK rows stay (visible when filtering by that camera) and are retried next run, since
 * the entrance event may be posted after the check event.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { prisma } from "../lib/prisma.ts";
import { env } from "../lib/env.ts";

const BEFORE_MS = 30_000; // check sighting may start this long before the IN ends (overlapping views)
const AFTER_MS = 120_000; // … or up to this long after the IN was last seen (walk to the stairs)
const MIN_SIM = 0.35; // an UNCERTAIN guess must be at least this close to take part
const CHECK_MATCH_SIM = 0.45; // a MATCHED check sighting may re-name an UNCERTAIN IN from its candidates

type Row = Awaited<ReturnType<typeof load>>[number];
const load = (since: Date, direction: string) => prisma.accessEvent.findMany({
  where: { direction, status: { in: ["MATCHED", "UNCERTAIN"] }, empCode: { not: null }, firstSeenAt: { gte: since } },
  orderBy: { firstSeenAt: "asc" },
  select: {
    id: true, cameraId: true, status: true, empCode: true, empName: true, similarity: true, margin: true, candidates: true,
    faceSize: true, frames: true, snapshotPath: true, firstSeenAt: true, lastSeenAt: true, reviewedAt: true, confirmedBy: true,
  },
});
const usable = (e: Row) => e.status === "MATCHED" || e.similarity >= MIN_SIM;
const candidateCodes = (e: Row) => { try { return (JSON.parse(e.candidates ?? "[]") as { code: string }[]).map((c) => c.code); } catch { return []; } };

async function dropSnapshot(path: string | null) {
  if (!path) return;
  if (await prisma.accessEvent.count({ where: { snapshotPath: path } })) return;
  const root = resolve(env.faceDataDir);
  const p = resolve(join(root, path));
  if (!p.startsWith(root + "/")) return;
  try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
}

export async function confirmEntriesByCheckCamera(since: Date): Promise<{ checks: number; merged: number; promoted: number }> {
  const checks = (await load(new Date(since.getTime() - AFTER_MS), "CHECK")).filter(usable);
  if (!checks.length) return { checks: 0, merged: 0, promoted: 0 };
  const ins = (await load(new Date(since.getTime() - AFTER_MS), "IN")).filter(usable);
  let merged = 0, promoted = 0;
  const gone = new Set<number>();

  for (const c of checks) {
    const cs = c.firstSeenAt.getTime();
    // the nearest IN before (or overlapping) this sighting that can be the same person
    let best: { e: Row; empCode: string; gap: number } | null = null;
    for (const e of ins) {
      if (gone.has(e.id)) continue;
      const gap = cs - e.lastSeenAt.getTime();
      if (cs < e.firstSeenAt.getTime() - BEFORE_MS || gap > AFTER_MS) continue;
      let who: string | null = null;
      if (e.empCode === c.empCode) {
        // both MATCHED to different people is impossible here; one UNCERTAIN + agreement is the point
        who = e.empCode;
      } else if (e.status === "UNCERTAIN" && !e.reviewedAt && c.status === "MATCHED" && c.similarity >= CHECK_MATCH_SIM && candidateCodes(e).includes(c.empCode!)) {
        who = c.empCode;
      }
      if (!who) continue;
      if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { e, empCode: who, gap };
    }
    if (!best) continue;
    const { e } = best;

    const wasUncertain = e.status === "UNCERTAIN";
    const takeFace = c.similarity > e.similarity && best.empCode === c.empCode;
    await prisma.accessEvent.update({
      where: { id: e.id },
      data: {
        status: "MATCHED",
        ...(best.empCode !== e.empCode ? { empCode: c.empCode, empName: c.empName } : {}),
        confirmedBy: e.confirmedBy ?? "CAM",
        frames: e.frames + c.frames,
        ...(takeFace ? { similarity: c.similarity, margin: c.margin, candidates: c.candidates, faceSize: c.faceSize, snapshotPath: c.snapshotPath } : {}),
      },
    });
    await prisma.accessEvent.delete({ where: { id: c.id } });
    await dropSnapshot(takeFace ? e.snapshotPath : c.snapshotPath);
    // keep the in-memory copy current for further check sightings of the same entry
    Object.assign(e, { status: "MATCHED", empCode: best.empCode, confirmedBy: e.confirmedBy ?? "CAM", frames: e.frames + c.frames },
      takeFace ? { similarity: c.similarity, snapshotPath: c.snapshotPath } : {});
    merged++;
    if (wasUncertain) promoted++;
  }
  return { checks: checks.length, merged, promoted };
}
