/**
 * Face entry/exit log (Phase 3): people recognized by the face worker (apps/face/worker.py) on the
 * entrance/exit cameras. Each row = one person passing one camera. Snapshot vs. employee photo,
 * manual correction, jump to the central recording, per-person daily summary, and (admin)
 * per-camera settings incl. drawing the detection zone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowDownToLine, ArrowUpFromLine, Check, Film, Pencil, RefreshCw, ScanFace, Settings2, X } from "lucide-react";
import clsx from "clsx";
import { api, API_URL, getToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Card, Field, Input, Modal, PageHeader, Select, StatusDot, toLocalInput } from "../components/ui";
import { ClipDialog } from "../components/ClipDialog";

type Status = "MATCHED" | "UNCERTAIN" | "UNKNOWN";
interface Cand { code: string; name: string; sim: number; photoUrl: string | null }
interface AccessEvent {
  id: number; cameraId: number; deviceNo: string; recorded: boolean; direction: "IN" | "OUT"; status: Status;
  empCode: string | null; empName: string | null; similarity: number; margin: number; candidates: Cand[];
  firstSeenAt: string; lastSeenAt: string; frames: number; faceSize: number;
  snapshotUrl: string | null; photoUrl: string | null; reviewedAt: string | null;
  /** "SCAN" = promoted from ไม่แน่ใจ because this person scanned a fingerprint right at the pass */
  confirmedBy?: string | null; scanGapSec?: number | null;
  /** movement during the pass (null for events recorded before 2026-11-11 18:42) */
  travelY: number | null; sizeGrowth: number | null;
}

/** Someone standing in the zone (guard post, chatting, waiting) rather than walking through: seen for
 *  a while but neither moved along the frame nor towards/away from the camera. Kept in the list
 *  (marked), never counted as an entry or exit. */
const isStationary = (e: Pick<AccessEvent, "frames" | "travelY" | "sizeGrowth">) =>
  e.travelY != null && e.sizeGrowth != null && e.frames >= 8 && Math.abs(e.travelY) < 0.04 && e.sizeGrowth > 0.85 && e.sizeGrowth < 1.2;
interface FaceCam {
  id: number; deviceNo: string; name: string; status: string; faceEnabled: boolean; faceDirection: "IN" | "OUT" | null; faceZone: string | null; recordEnabled: boolean;
  job: { running: boolean; fps: number; processedFps: number; busyPct: number; tracks: number; events: number; lastError: string | null } | null;
}
interface FaceStatus {
  worker: { alive: boolean; updatedAt: string; gallery: { employees: number; templates: number } | null } | null;
  employees: number;
  cameras: FaceCam[];
}

const STATUS_LABEL: Record<Status, string> = { MATCHED: "ตรงกัน", UNCERTAIN: "ไม่แน่ใจ", UNKNOWN: "ไม่รู้จัก" };
const STATUS_CLS: Record<Status, string> = {
  MATCHED: "bg-emerald-900/40 text-emerald-300 ring-emerald-700/50",
  UNCERTAIN: "bg-amber-900/30 text-amber-300 ring-amber-700/50",
  UNKNOWN: "bg-ink-800 text-zinc-400 ring-ink-700",
};
type Grouped = AccessEvent & { count: number; at: string; ids: number[] };

/** Grouping window presets (minutes); any other value is a custom one. Remembered per browser. */
const GROUP_PRESETS = [0, 5, 10, 15, 30, 60];
const GROUP_KEY = "access.groupMin";
const loadGroupMin = () => {
  try { const v = Number(localStorage.getItem(GROUP_KEY)); return Number.isFinite(v) && v >= 0 && v <= 480 && localStorage.getItem(GROUP_KEY) !== null ? v : 30; } catch { return 30; }
};
const fmtTime = (s: string) => new Date(s).toLocaleTimeString("th-TH", { hour12: false });
const hm = (s: string) => new Date(s).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false });
const dur = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} นาที` : `${Math.floor(m / 60)} ชม. ${m % 60} นาที`; };

/** One stay inside the building: an IN (entrance camera) paired with the next OUT (exit camera).
 *  A pass with no partner is listed separately as "unpaired" — never guessed, never counted. */
interface Visit { in: Grouped; out: Grouped }
const localDay = (d: Date) => toLocalInput(d).slice(0, 10);

const Img = ({ src, className, alt }: { src: string | null; className?: string; alt: string }) =>
  src ? <img src={API_URL + src} alt={alt} loading="lazy" className={clsx("bg-ink-950 object-cover", className)} />
    : <div className={clsx("grid place-items-center bg-ink-950 text-[10px] text-zinc-600", className)}>ไม่มีรูป</div>;

const DirBadge = ({ d }: { d: "IN" | "OUT" }) => d === "IN"
  ? <span className="inline-flex items-center gap-1 text-sky-300"><ArrowDownToLine size={12} /> เข้า</span>
  : <span className="inline-flex items-center gap-1 text-orange-300"><ArrowUpFromLine size={12} /> ออก</span>;

// ── per-camera settings + zone editor (admin) ──────────────────────────────────────────────
function ZoneEditor({ cam, onClose }: { cam: FaceCam; onClose: () => void }) {
  const qc = useQueryClient();
  const [img, setImg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zone, setZone] = useState<number[]>(cam.faceZone ? cam.faceZone.split(",").map(Number) : [0, 0, 1, 1]);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = async () => {
    setErr(null);
    try {
      const res = await fetch(`${API_URL}/api/face/cameras/${cam.id}/frame`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`โหลดภาพไม่ได้ (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      setImg((old) => { if (old) URL.revokeObjectURL(old); return url; });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = (e: React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const save = useMutation({
    mutationFn: () => api(`/api/face/cameras/${cam.id}`, { method: "PATCH", json: { faceZone: zone.map((v) => v.toFixed(4)).join(",") } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["face", "status"] }); onClose(); },
    onError: (e) => setErr((e as Error).message),
  });
  const [x0, y0, x1, y1] = zone as [number, number, number, number];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-6xl rounded-2xl border border-ink-700 bg-ink-900 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-3">
          <div className="font-display text-base font-semibold text-cream">โซนตรวจจับใบหน้า — {cam.deviceNo}</div>
          <div className="text-xs text-zinc-500">ลากเมาส์บนภาพเพื่อกำหนดกรอบ: ช่วงที่คนเพิ่งผ่านประตูและเดินเข้าหากล้อง (หลีกเลี่ยงกระจกประตู)</div>
          <button className="ml-auto text-zinc-400 hover:text-cream" onClick={onClose}><X size={18} /></button>
        </div>
        <div
          ref={box}
          className="relative w-full cursor-crosshair select-none overflow-hidden rounded bg-black"
          style={{ aspectRatio: "16 / 9" }}
          onMouseDown={(e) => { const p = pos(e); setDrag(p); setZone([p.x, p.y, p.x, p.y]); }}
          onMouseMove={(e) => { if (!drag) return; const p = pos(e); setZone([Math.min(drag.x, p.x), Math.min(drag.y, p.y), Math.max(drag.x, p.x), Math.max(drag.y, p.y)]); }}
          onMouseUp={() => setDrag(null)}
          onMouseLeave={() => setDrag(null)}
        >
          {img ? <img src={img} className="pointer-events-none absolute inset-0 h-full w-full object-fill" alt="" /> : <div className="grid h-full place-items-center text-sm text-zinc-500">{err ?? "กำลังโหลดภาพ…"}</div>}
          <div className="pointer-events-none absolute border-2 border-gold-400 bg-gold-400/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
            style={{ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` }} />
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          <span className="font-mono">{zone.map((v) => v.toFixed(3)).join(", ")}</span>
          {err && <span className="text-red-400">{err}</span>}
          <Button variant="ghost" className="ml-auto" onClick={load}><RefreshCw size={13} /> ภาพใหม่</Button>
          <Button variant="ghost" onClick={() => setZone([0, 0, 1, 1])}>ทั้งภาพ</Button>
          <Button variant="gold" disabled={x1 - x0 < 0.05 || y1 - y0 < 0.05 || save.isPending} onClick={() => save.mutate()}>บันทึกโซน</Button>
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({ status, isAdmin }: { status: FaceStatus | undefined; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [zoneCam, setZoneCam] = useState<FaceCam | null>(null);
  const [addId, setAddId] = useState("");
  const allCams = useQuery({ queryKey: ["cameras", "all"], queryFn: () => api<{ id: number; deviceNo: string; name: string; isEnabled: boolean }[]>("/api/cameras"), enabled: isAdmin });
  const patch = useMutation({
    mutationFn: (v: { id: number; faceEnabled?: boolean; faceDirection?: "IN" | "OUT" }) => api(`/api/face/cameras/${v.id}`, { method: "PATCH", json: { faceEnabled: v.faceEnabled, faceDirection: v.faceDirection } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["face", "status"] }),
  });
  const w = status?.worker;
  return (
    <Card className="mx-5 mb-3 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="flex items-center gap-1.5">
          <span className={clsx("h-2 w-2 rounded-full", w?.alive ? "bg-emerald-400" : "bg-red-500")} />
          ตัวจดจำใบหน้า {w?.alive ? "ทำงาน" : "ไม่ทำงาน"}
        </span>
        <span className="text-zinc-400">ฐานข้อมูลใบหน้า {w?.gallery?.employees.toLocaleString() ?? "-"} / พนักงาน {status?.employees.toLocaleString() ?? "-"} คน</span>
        <span className="text-zinc-500">รูปจากกล้องเก็บ 30 วัน · ข้อมูลใบหน้าอยู่บนเซิร์ฟเวอร์เท่านั้น</span>
      </div>
      <table className="w-full">
        <thead className="text-left text-zinc-500">
          <tr><th className="py-1 font-normal">กล้อง</th><th className="font-normal">ทิศทาง</th><th className="font-normal">สถานะ</th><th className="font-normal">ภาพ/วินาที</th><th className="font-normal">CPU</th><th className="font-normal">รายการ (ตั้งแต่เริ่ม)</th><th /></tr>
        </thead>
        <tbody>
          {status?.cameras.map((c) => (
            <tr key={c.id} className="border-t border-ink-800/60">
              <td className="py-1"><StatusDot status={c.status} /> <span className="text-cream">{c.deviceNo}</span> <span className="text-zinc-500">{c.name}</span></td>
              <td>
                {isAdmin ? (
                  <Select className="!w-24 !py-0.5 text-xs" value={c.faceDirection ?? "IN"} onChange={(e) => patch.mutate({ id: c.id, faceDirection: e.target.value as "IN" | "OUT" })}>
                    <option value="IN">เข้า</option><option value="OUT">ออก</option>
                  </Select>
                ) : c.faceDirection && <DirBadge d={c.faceDirection} />}
              </td>
              <td>
                {!c.faceEnabled ? <span className="text-zinc-500">ปิด</span>
                  : c.job?.running ? <span className="text-emerald-400">● กำลังตรวจ</span>
                  : <span className="text-amber-400" title={c.job?.lastError ?? ""}>รอเชื่อมต่อ</span>}
                {c.job?.lastError && <div className="max-w-xs truncate text-[10px] text-red-400">{c.job.lastError}</div>}
              </td>
              <td>{c.job ? `${c.job.fps} / ตรวจ ${c.job.processedFps}` : "-"}</td>
              <td>{c.job ? `${c.job.busyPct}%` : "-"}</td>
              <td>{c.job?.events ?? "-"}</td>
              <td className="space-x-1 text-right">
                {isAdmin && <>
                  <button className="rounded px-2 py-0.5 text-zinc-400 hover:bg-ink-800 hover:text-cream" onClick={() => setZoneCam(c)}><Settings2 size={11} className="inline" /> โซน</button>
                  <button className="rounded px-2 py-0.5 text-zinc-400 hover:bg-ink-800 hover:text-cream" onClick={() => patch.mutate({ id: c.id, faceEnabled: !c.faceEnabled })}>{c.faceEnabled ? "ปิด" : "เปิด"}</button>
                </>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && (
        <div className="mt-2 flex items-center gap-2">
          <Select className="w-80" value={addId} onChange={(e) => setAddId(e.target.value)}>
            <option value="">+ เพิ่มกล้องตรวจใบหน้า…</option>
            {allCams.data?.filter((c) => c.isEnabled && !status?.cameras.some((f) => f.id === c.id)).map((c) => <option key={c.id} value={c.id}>{c.deviceNo} {c.name}</option>)}
          </Select>
          <Button disabled={!addId || patch.isPending} onClick={() => { patch.mutate({ id: Number(addId), faceEnabled: false, faceDirection: "IN" }); setAddId(""); }}>เพิ่ม</Button>
          <span className="text-zinc-500">เพิ่มแล้วให้วาดโซนก่อนเปิดใช้</span>
        </div>
      )}
      {zoneCam && <ZoneEditor cam={zoneCam} onClose={() => setZoneCam(null)} />}
    </Card>
  );
}

// ── correction dialog ───────────────────────────────────────────────────────────────────────
function CorrectDialog({ ev, onClose }: { ev: AccessEvent; onClose: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => { const t = setTimeout(() => setDq(q), 300); return () => clearTimeout(t); }, [q]);
  const search = useQuery({
    queryKey: ["face", "employees", dq],
    queryFn: () => api<{ code: string; name: string; photoUrl: string | null }[]>(`/api/face/employees?q=${encodeURIComponent(dq)}`),
    enabled: dq.trim().length >= 2,
  });
  const set = useMutation({
    mutationFn: (empCode: string | null) => api(`/api/face/events/${ev.id}`, { method: "PATCH", json: { empCode } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["face", "events"] }); onClose(); },
  });
  const Choice = ({ code, name, photoUrl, sim }: { code: string; name: string; photoUrl: string | null; sim?: number }) => (
    <button className={clsx("flex w-full items-center gap-3 rounded-lg p-1.5 text-left hover:bg-ink-800", ev.empCode === code && "ring-1 ring-gold-600")} onClick={() => set.mutate(code)}>
      <Img src={photoUrl} alt={code} className="h-14 w-11 rounded" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-cream">{name}</div>
        <div className="text-xs text-zinc-500">{code}{sim !== undefined && ` · คะแนน ${sim.toFixed(2)}`}</div>
      </div>
    </button>
  );
  return (
    <Modal title="แก้ไขผู้ที่ผ่านกล้อง" onClose={onClose} wide>
      <div className="flex gap-4">
        <div className="shrink-0">
          <Img src={ev.snapshotUrl} alt="" className="h-48 w-48 rounded-lg" />
          <div className="mt-1 text-center text-xs text-zinc-500">{ev.deviceNo} · {fmtTime(ev.firstSeenAt)}</div>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <div className="mb-1 text-xs text-zinc-400">ระบบเสนอ</div>
            {ev.candidates.map((c) => <Choice key={c.code} {...c} />)}
          </div>
          <Field label="ค้นหาพนักงาน (รหัส หรือ ชื่อ)"><Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="อย่างน้อย 2 ตัวอักษร" /></Field>
          <div className="max-h-60 overflow-auto">{search.data?.map((e) => <Choice key={e.code} {...e} />)}</div>
          <div className="flex justify-between border-t border-ink-800 pt-3">
            <Button variant="ghost" onClick={() => set.mutate(null)}>ไม่ใช่พนักงาน / ไม่รู้จัก</Button>
            <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── page ────────────────────────────────────────────────────────────────────────────────────
export function Access() {
  const { user, can } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const navigate = useNavigate();
  const [day, setDay] = useState(localDay(new Date()));
  const [cameraId, setCameraId] = useState("");
  const [direction, setDirection] = useState("");
  const [statusF, setStatusF] = useState<Status[]>(["MATCHED", "UNCERTAIN"]);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"list" | "people">("list");
  const [peopleF, setPeopleF] = useState<"all" | "complete" | "lone">("all");
  const [editing, setEditing] = useState<AccessEvent | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const isToday = day === localDay(new Date());

  const status = useQuery({ queryKey: ["face", "status"], queryFn: () => api<FaceStatus>("/api/face/status"), refetchInterval: 15000 });
  const from = new Date(`${day}T00:00:00`);
  const to = new Date(from.getTime() + 24 * 3600_000);
  // camera / direction / status filters belong to the list tab: the per-person pairing needs both cameras
  const qCam = tab === "list" ? cameraId : "", qDir = tab === "list" ? direction : "";
  const events = useQuery({
    queryKey: ["face", "events", day, qCam, qDir],
    queryFn: () => api<AccessEvent[]>(`/api/face/events?from=${from.toISOString()}&to=${to.toISOString()}${qCam ? `&cameraId=${qCam}` : ""}${qDir ? `&direction=${qDir}` : ""}`),
    refetchInterval: isToday ? 15000 : false,
  });
  const all = events.data ?? [];
  const counts = useMemo(() => ({
    MATCHED: all.filter((e) => e.status === "MATCHED").length,
    UNCERTAIN: all.filter((e) => e.status === "UNCERTAIN").length,
    UNKNOWN: all.filter((e) => e.status === "UNKNOWN").length,
  }), [all]);
  const ql = q.trim().toLowerCase();
  const filtered = all.filter((e) => (tab === "people" || statusF.includes(e.status)) && (!ql || e.empCode?.toLowerCase().includes(ql) || e.empName?.toLowerCase().includes(ql)));

  /** One time per pass: the same person + same direction within `groupMin` minutes of the previous
   *  sighting is one passage. IN shows the earliest time, OUT the latest. Unmatched rows stay single. */
  const [groupMin, setGroupMinState] = useState(loadGroupMin);
  const [customGroup, setCustomGroup] = useState(() => !GROUP_PRESETS.includes(loadGroupMin()));
  const setGroupMin = (v: number) => { setGroupMinState(v); try { localStorage.setItem(GROUP_KEY, String(v)); } catch {} };
  const rows = useMemo(() => {
    if (!groupMin) return filtered.map((e) => ({ ...e, count: 1, ids: [e.id], at: e.direction === "IN" ? e.firstSeenAt : e.lastSeenAt }));
    const gap = groupMin * 60_000;
    const asc = [...filtered].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
    const open = new Map<string, Grouped>();
    const out: Grouped[] = [];
    for (const e of asc) {
      // "ตรงกัน" rows group with "ตรงกัน", "ไม่แน่ใจ" with "ไม่แน่ใจ" of the same suggested person.
      const key = e.status !== "UNKNOWN" && e.empCode && !isStationary(e) ? `${e.status}|${e.empCode}|${e.direction}` : null;
      const g = key ? open.get(key) : undefined;
      if (g && new Date(e.firstSeenAt).getTime() - new Date(g.lastSeenAt).getTime() <= gap) {
        if (e.lastSeenAt > g.lastSeenAt) g.lastSeenAt = e.lastSeenAt;
        g.count++;
        g.ids.push(e.id);
        if (e.similarity > g.similarity) Object.assign(g, { id: e.id, similarity: e.similarity, margin: e.margin, snapshotUrl: e.snapshotUrl, candidates: e.candidates, deviceNo: e.deviceNo });
        g.at = g.direction === "IN" ? g.firstSeenAt : g.lastSeenAt;
        continue;
      }
      const n: Grouped = { ...e, count: 1, ids: [e.id], at: e.direction === "IN" ? e.firstSeenAt : e.lastSeenAt };
      out.push(n);
      if (key) open.set(key, n);
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [filtered, groupMin]);

  /** First IN / last OUT per employee for the day (confident or corrected matches only). */
  /** Per employee: their passes in time order, paired IN → next OUT into visits. Uses the grouped rows
   *  (so repeated sightings within the grouping window are already one pass) and only confident or
   *  hand-confirmed matches. */
  const people = useMemo(() => {
    const byEmp = new Map<string, Grouped[]>();
    for (const e of rows) {
      if (e.status !== "MATCHED" || !e.empCode || isStationary(e)) continue;
      byEmp.set(e.empCode, [...(byEmp.get(e.empCode) ?? []), e]);
    }
    const out = [...byEmp.entries()].map(([code, evs]) => {
      evs.sort((a, b) => a.at.localeCompare(b.at));
      const visits: Visit[] = [];
      const lone: Grouped[] = [];
      let open: Grouped | null = null;
      for (const e of evs) {
        if (e.direction === "IN") {
          if (open) lone.push(open); // previous IN never got an OUT
          open = e;
        } else if (open) {
          visits.push({ in: open, out: e });
          open = null;
        } else {
          lone.push(e); // OUT without a recognised IN before it
        }
      }
      if (open) lone.push(open);
      lone.sort((a, b) => a.at.localeCompare(b.at));
      const inside = visits.reduce((t, v) => t + new Date(v.out.at).getTime() - new Date(v.in.at).getTime(), 0);
      const first = evs[0]!;
      return {
        code, name: first.empName ?? "", photoUrl: first.photoUrl, visits, lone, inside,
        firstIn: evs.find((e) => e.direction === "IN")?.at ?? null,
        lastOut: [...evs].reverse().find((e) => e.direction === "OUT")?.at ?? null,
      };
    });
    return out
      .filter((p) => !ql || p.code.toLowerCase().includes(ql) || p.name.toLowerCase().includes(ql))
      .sort((a, b) => (a.firstIn ?? a.lastOut ?? "").localeCompare(b.firstIn ?? b.lastOut ?? ""));
  }, [rows, ql]);
  const peopleCounts = useMemo(() => ({
    all: people.length,
    complete: people.filter((p) => p.visits.length && !p.lone.length).length,
    lone: people.filter((p) => p.lone.length).length,
  }), [people]);
  const shownPeople = people.filter((p) => peopleF === "all" || (peopleF === "complete" ? p.visits.length && !p.lone.length : p.lone.length));

  const [clip, setClip] = useState<{ cameraId: number; at: number; title: string } | null>(null);
  const openVideo = (e: Grouped) => setClip({ cameraId: e.cameraId, at: new Date(e.at).getTime(), title: `${e.empName ?? "ไม่ทราบชื่อ"} ${e.empCode ?? ""} · ${e.direction === "IN" ? "เข้า" : "ออก"} ${e.deviceNo}` });
  const qc = useQueryClient();
  /** One-click "yes, that's the suggested person" for UNCERTAIN rows (all events of a grouped row). */
  const confirm = useMutation({
    mutationFn: async (v: { ids: number[]; empCode: string }) => {
      for (const id of v.ids) await api(`/api/face/events/${id}`, { method: "PATCH", json: { empCode: v.empCode } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["face", "events"] }),
    onError: (e) => alert((e as Error).message),
  });
  const toggleStatus = (s: Status) => setStatusF((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="บันทึกเข้า-ออก (ทดสอบ)" subtitle="จดจำใบหน้าจากกล้องทางเข้า-ออก · ข้อมูลใบหน้าประมวลผลบนเซิร์ฟเวอร์ภายในเท่านั้น">
        <Button variant="ghost" onClick={() => setShowSettings((v) => !v)}><Settings2 size={14} /> กล้องและสถานะ</Button>
      </PageHeader>
      {(showSettings || status.data?.worker?.alive === false) && <SettingsPanel status={status.data} isAdmin={isAdmin} />}

      <div className="flex flex-wrap items-end gap-2 px-5 pb-3 pt-3">
        <Field label="วันที่"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        {tab === "list" && <><Field label="กล้อง">
          <Select className="w-56" value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
            <option value="">ทุกกล้อง</option>
            {status.data?.cameras.map((c) => <option key={c.id} value={c.id}>{c.deviceNo} ({c.faceDirection === "OUT" ? "ออก" : "เข้า"})</option>)}
          </Select>
        </Field>
        <Field label="ทิศทาง">
          <Select className="w-28" value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="">ทั้งหมด</option><option value="IN">เข้า</option><option value="OUT">ออก</option>
          </Select>
        </Field></>}
        <Field label="ค้นหา"><Input className="w-56" value={q} onChange={(e) => setQ(e.target.value)} placeholder="รหัส หรือ ชื่อพนักงาน" /></Field>
        <div className="ml-auto flex overflow-hidden rounded-lg ring-1 ring-ink-700">
          <button onClick={() => setTab("list")} className={clsx("px-3 py-1.5 text-xs", tab === "list" ? "bg-gold-500 text-onaccent" : "text-zinc-400 hover:bg-ink-800")}>รายการ</button>
          <button onClick={() => setTab("people")} className={clsx("px-3 py-1.5 text-xs", tab === "people" ? "bg-gold-500 text-onaccent" : "text-zinc-400 hover:bg-ink-800")}>สรุปรายคน</button>
        </div>
      </div>

      {tab === "people" && (
        <div className="flex items-center gap-2 px-5 pb-2 text-xs">
          {([["all", "ทั้งหมด"], ["complete", "จับคู่ครบทุกรอบ"], ["lone", "มีรายการจับคู่ไม่ได้"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setPeopleF(k)} className={clsx("rounded-full px-2.5 py-0.5 ring-1", peopleF === k ? "bg-gold-500 text-onaccent ring-gold-500" : "text-zinc-400 ring-ink-700 hover:bg-ink-800")}>
              {l} {peopleCounts[k]}
            </button>
          ))}
          <span className="ml-2 text-zinc-500">เข้า = กล้อง FL1-40 · ออก = กล้อง OD1-30</span>
        </div>
      )}

      {tab === "list" && (
        <div className="flex items-center gap-2 px-5 pb-2 text-xs">
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
            <button key={s} onClick={() => toggleStatus(s)} className={clsx("rounded-full px-2.5 py-0.5 ring-1", statusF.includes(s) ? STATUS_CLS[s] : "text-zinc-600 ring-ink-800")}>
              {STATUS_LABEL[s]} {counts[s]}
            </button>
          ))}
          <span className="ml-2 text-zinc-500">แสดง {rows.length} รายการ{isToday && " · อัปเดตทุก 15 วินาที"}</span>
          <label className="ml-auto flex items-center gap-1.5 text-zinc-400">
            รวมการผ่านของคนเดียวกันภายใน
            <Select
              className="!w-28 !py-0.5 text-xs"
              value={customGroup ? "custom" : groupMin}
              onChange={(e) => {
                if (e.target.value === "custom") { setCustomGroup(true); return; }
                setCustomGroup(false); setGroupMin(Number(e.target.value));
              }}
            >
              {GROUP_PRESETS.map((m) => <option key={m} value={m}>{m === 0 ? "ไม่รวม" : `${m} นาที`}</option>)}
              <option value="custom">กำหนดเอง…</option>
            </Select>
            {customGroup && (
              <span className="flex items-center gap-1">
                <Input type="number" min={1} max={480} className="!w-16 !py-0.5 text-xs" value={groupMin || ""}
                  onChange={(e) => { const v = Math.max(0, Math.min(480, Math.round(Number(e.target.value) || 0))); setGroupMin(v); }} />
                นาที
              </span>
            )}
            <span className="text-zinc-600">(เข้า = เวลาแรก, ออก = เวลาสุดท้าย)</span>
          </label>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
        {events.isLoading ? <div className="p-6 text-sm text-zinc-500">กำลังโหลด…</div>
          : tab === "list" ? (
            rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-10 text-sm text-zinc-500"><ScanFace size={28} /> ไม่มีรายการในวันนี้</div>
            ) : (
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(330px,1fr))]">
                {rows.map((e) => (
                  <Card key={e.id} className="flex gap-2 p-2">
                    <Img src={e.snapshotUrl} alt="กล้อง" className="h-28 w-24 shrink-0 rounded" />
                    <Img src={e.photoUrl} alt="พนักงาน" className="h-28 w-[84px] shrink-0 rounded" />
                    <div className="flex min-w-0 flex-1 flex-col text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sm text-cream" title={e.count > 1 ? `${fmtTime(e.firstSeenAt)} – ${fmtTime(e.lastSeenAt)}` : undefined}>{fmtTime(e.at)}</span>
                        <DirBadge d={e.direction} />
                        {isStationary(e) && <span className="rounded bg-ink-800 px-1 text-[10px] text-zinc-500" title="ยืนอยู่ในกรอบ ไม่ได้เดินผ่าน — ไม่นับเป็นเข้า/ออก">ยืนอยู่กับที่</span>}
                        {e.count > 1 && <span className="rounded bg-ink-800 px-1 text-[10px] text-zinc-400" title={`${fmtTime(e.firstSeenAt)} – ${fmtTime(e.lastSeenAt)}`}>รวม {e.count} ครั้ง</span>}
                      </div>
                      <div className="truncate text-sm text-cream" title={e.empName ?? ""}>{e.empName ?? (e.status === "UNKNOWN" ? "ไม่ทราบชื่อ" : "-")}</div>
                      <div className="text-zinc-500">{e.empCode ?? ""}</div>
                      <div className="mt-auto flex items-center gap-1.5">
                        <span className={clsx("rounded px-1.5 py-px ring-1", STATUS_CLS[e.status])}>{STATUS_LABEL[e.status]}{e.reviewedAt && " ✓"}</span>
                        {e.confirmedBy === "SCAN" && !e.reviewedAt && <span className="rounded bg-ink-800 px-1 text-[10px] text-gold-300" title={`ระบบเดาไว้ว่า "ไม่แน่ใจ" แต่คนนี้สแกนนิ้วห่างจากเวลาผ่านกล้อง ${Math.round((e.scanGapSec ?? 0) / 60 * 10) / 10} นาที จึงยืนยันให้อัตโนมัติ`}>ยืนยันด้วยสแกน</span>}
                        <span className="text-zinc-500" title={`ห่างอันดับ 2: ${e.margin.toFixed(2)} · ${e.frames} ภาพ · หน้า ${e.faceSize}px`}>{e.similarity.toFixed(2)}</span>
                        <span className="text-zinc-600">{e.deviceNo}</span>
                        <span className="ml-auto flex">
                          {e.recorded && <button className="rounded p-1 text-zinc-400 hover:bg-ink-800 hover:text-cream" title="ดูวิดีโอ" onClick={() => openVideo(e)}><Film size={14} /></button>}
                          {can("OPERATOR") && e.status === "UNCERTAIN" && e.empCode && (
                            <button className="rounded p-1 text-emerald-400 hover:bg-ink-800 hover:text-emerald-300 disabled:opacity-40" title={`ยืนยันว่าเป็น ${e.empName ?? e.empCode}${e.count > 1 ? ` (ทั้ง ${e.count} รายการ)` : ""} — ระบบจะจดจำหน้านี้ไว้ช่วยครั้งต่อไป`}
                              disabled={confirm.isPending} onClick={() => confirm.mutate({ ids: e.ids, empCode: e.empCode! })}><Check size={14} /></button>
                          )}
                          {can("OPERATOR") && <button className="rounded p-1 text-zinc-400 hover:bg-ink-800 hover:text-cream" title="แก้ไขชื่อ" onClick={() => setEditing(e)}><Pencil size={14} /></button>}
                        </span>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )
          ) : (
            <Card className="overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-ink-850 text-left text-xs text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-normal" /><th className="font-normal">พนักงาน</th>
                    <th className="font-normal">รอบที่จับคู่ได้ (เข้า → ออก)</th>
                    <th className="font-normal">จับคู่ไม่ได้</th>
                    <th className="font-normal">เข้าแรก</th><th className="font-normal">ออกสุดท้าย</th>
                    <th className="pr-3 font-normal">อยู่ในอาคารรวม</th>
                  </tr>
                </thead>
                <tbody>
                  {shownPeople.map((p) => (
                    <tr key={p.code} className="border-t border-ink-800/60 align-top">
                      <td className="w-14 px-3 py-1.5"><Img src={p.photoUrl} alt={p.code} className="h-12 w-9 rounded" /></td>
                      <td className="py-1.5"><div className="text-cream">{p.name}</div><div className="text-xs text-zinc-500">{p.code}</div></td>
                      <td className="py-1.5">
                        {p.visits.length ? (
                          <div className="flex flex-col gap-0.5 text-xs">
                            {p.visits.map((v, i) => (
                              <div key={i} className="flex items-center gap-1">
                                <button className="font-mono text-emerald-300 hover:underline" title={`เข้า ${fmtTime(v.in.at)} · ${v.in.deviceNo} · ดูวิดีโอ`} onClick={() => openVideo(v.in)}>{hm(v.in.at)}</button>
                                <span className="text-zinc-600">→</span>
                                <button className="font-mono text-sky-300 hover:underline" title={`ออก ${fmtTime(v.out.at)} · ${v.out.deviceNo} · ดูวิดีโอ`} onClick={() => openVideo(v.out)}>{hm(v.out.at)}</button>
                                <span className="text-zinc-500">{dur(new Date(v.out.at).getTime() - new Date(v.in.at).getTime())}</span>
                              </div>
                            ))}
                          </div>
                        ) : <span className="text-xs text-zinc-600">-</span>}
                      </td>
                      <td className="py-1.5">
                        {p.lone.length ? (
                          <div className="flex max-w-xs flex-wrap gap-x-2 gap-y-0.5 text-xs">
                            {p.lone.map((e) => (
                              <button key={e.id} onClick={() => openVideo(e)} className="text-zinc-500 hover:text-cream"
                                title={`${e.direction === "IN" ? "เห็นเข้า แต่ไม่พบออกที่ตามมา" : "เห็นออก แต่ไม่พบเข้าก่อนหน้า"} · ${fmtTime(e.at)} · ${e.deviceNo} · ดูวิดีโอ`}>
                                {e.direction === "IN" ? "เข้า" : "ออก"} <span className="font-mono">{hm(e.at)}</span>
                              </button>
                            ))}
                          </div>
                        ) : <span className="text-xs text-zinc-600">-</span>}
                      </td>
                      <td className="py-1.5 font-mono">{p.firstIn ? hm(p.firstIn) : <span className="text-zinc-600">-</span>}</td>
                      <td className="py-1.5 font-mono">{p.lastOut ? hm(p.lastOut) : <span className="text-zinc-600">-</span>}</td>
                      <td className="py-1.5 pr-3 text-zinc-300">{p.visits.length ? dur(p.inside) : <span className="text-zinc-600">-</span>}</td>
                    </tr>
                  ))}
                  {shownPeople.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-zinc-500">ยังไม่มีพนักงานที่ระบบจดจำได้แน่ชัดในวันนี้</td></tr>}
                </tbody>
              </table>
              <div className="space-y-0.5 border-t border-ink-800 px-3 py-2 text-xs text-zinc-500">
                <div>1 รอบ = เวลาเข้า (กล้อง FL1-40) จับคู่กับเวลาออกถัดไป (กล้อง OD1-30) ของคนเดียวกัน · การผ่านซ้ำภายในช่วง "รวมการผ่าน" นับเป็นครั้งเดียว · กดที่เวลาเพื่อดูวิดีโอ</div>
                <div>"จับคู่ไม่ได้" = เห็นเข้าแต่ไม่พบออกที่ตามมา หรือเห็นออกแต่ไม่พบเข้าก่อนหน้า (กล้องอีกฝั่งจดจำหน้าไม่ได้) — ไม่นำไปคิดเวลา · "อยู่ในอาคารรวม" นับเฉพาะรอบที่จับคู่ได้ · คนที่ยืนอยู่ในกรอบ (ไม่ได้เดินผ่าน) ไม่นับ</div>
                <div>นับเฉพาะรายการ "ตรงกัน" (รวมที่ยืนยัน/แก้ไขด้วยมือ) — รายการ "ไม่แน่ใจ" ให้ตรวจในแท็บรายการก่อน</div>
              </div>
            </Card>
          )}
      </div>
      {editing && <CorrectDialog ev={editing} onClose={() => setEditing(null)} />}
      {clip && <ClipDialog cameraId={clip.cameraId} at={clip.at} title={clip.title} onClose={() => setClip(null)} />}
    </div>
  );
}
