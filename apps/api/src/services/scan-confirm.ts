/**
 * Fingerprint-backed confirmation of face matches.
 *
 * Measured on 11 Nov (FL1-40): the top suggestion of an UNCERTAIN event scanned a fingerprint within
 * −2…+10 min of the pass in 74 % (sim 0.35–0.40) / 93 % (0.40–0.45) / 97 % (≥ 0.45) of cases, against
 * 14–23 % for the runner-up (chance level). So an UNCERTAIN pass whose suggested person really did scan
 * right then is promoted to MATCHED with confirmedBy = "SCAN" (the original guess is kept in empCode;
 * a human correction always wins: reviewed events are never touched).
 *
 * Window: entering → scan from 2 min before to 10 min after the pass (people walk to their floor's
 * scanner); leaving → 10 min before to 2 min after. Ambiguous cases (runner-up also scanned in the
 * window and scores nearly tied) are left UNCERTAIN for a person.
 */
import { prisma } from "../lib/prisma.ts";

const WIN = { IN: [-2 * 60, 10 * 60], OUT: [-10 * 60, 2 * 60] } as const;
const MIN_SIM = 0.35;
const TIE_MARGIN = 0.03;

const code = (u: string) => (/^\d{1,3}$/.test(u) ? u.padStart(4, "0") : u);

export async function confirmByScans(since: Date): Promise<{ checked: number; confirmed: number }> {
  const evs = await prisma.accessEvent.findMany({
    where: { status: "UNCERTAIN", reviewedAt: null, confirmedBy: null, empCode: { not: null }, similarity: { gte: MIN_SIM }, firstSeenAt: { gte: since } },
    select: { id: true, empCode: true, direction: true, firstSeenAt: true, lastSeenAt: true, margin: true, candidates: true },
  });
  if (!evs.length) return { checked: 0, confirmed: 0 };
  const min = new Date(Math.min(...evs.map((e) => e.firstSeenAt.getTime())) - 15 * 60_000);
  const max = new Date(Math.max(...evs.map((e) => e.lastSeenAt.getTime())) + 15 * 60_000);
  const scans = await prisma.attendancePunch.findMany({ where: { punchAt: { gte: min, lte: max } }, select: { userId: true, punchAt: true } });
  const by = new Map<string, number[]>();
  for (const s of scans) { const k = code(s.userId); const l = by.get(k); if (l) l.push(s.punchAt.getTime()); else by.set(k, [s.punchAt.getTime()]); }
  // nearest scan inside the direction's window, as seconds from the pass
  const gap = (c: string | undefined | null, at: number, dir: string) => {
    if (!c) return null;
    const [a, b] = dir === "OUT" ? WIN.OUT : WIN.IN;
    let best: number | null = null;
    for (const x of by.get(c) ?? []) {
      const d = Math.round((x - at) / 1000);
      if (d >= a && d <= b && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    return best;
  };
  let confirmed = 0;
  for (const e of evs) {
    const at = (e.direction === "OUT" ? e.lastSeenAt : e.firstSeenAt).getTime();
    const g = gap(e.empCode, at, e.direction);
    if (g === null) continue;
    let runner: string | undefined;
    try { runner = (JSON.parse(e.candidates ?? "[]") as { code: string }[])[1]?.code; } catch { /* ignore */ }
    if (e.margin < TIE_MARGIN && gap(runner, at, e.direction) !== null) continue; // both scanned, nearly tied → a person decides
    await prisma.accessEvent.update({ where: { id: e.id }, data: { status: "MATCHED", confirmedBy: "SCAN", scanGapSec: g } });
    confirmed++;
  }
  return { checked: evs.length, confirmed };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startScanConfirmScheduler() {
  const run = (hours: number) => confirmByScans(new Date(Date.now() - hours * 3600_000))
    .then((r) => { if (r.confirmed) console.log("[scan-confirm]", r); })
    .catch((e) => console.error("[scan-confirm]", (e as Error).message));
  setTimeout(() => run(24 * 30), 20_000); // back-fill on start
  timer = setInterval(() => run(6), 5 * 60_000);
}
