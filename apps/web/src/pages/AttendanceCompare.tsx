/**
 * เทียบเวลาเข้างาน — fingerprint scans (ZKTeco, every floor) next to what the entrance cameras saw,
 * one row per employee per day, with flags for the cases people argue about.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, CloudDownload, Fingerprint, Film, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { api, API_URL } from "../lib/api";
import { Button, Card, Input, PageHeader, toLocalInput } from "../components/ui";
import { ClipDialog } from "../components/ClipDialog";

interface Scan { at: string; device: string; floor: string | null; clockOffsetSec: number | null }
interface Pass { at: string; first: string; last: string; direction: "IN" | "OUT"; status: string; cameraId: number; deviceNo: string; recorded: boolean; count: number; eventId: number; snapshotUrl: string | null; byScan?: boolean; byCam?: boolean }
interface Slot { scan: Scan | null; camera: Pass | null }
type PeriodKey = "IN" | "BREAK_OUT" | "BREAK_IN" | "OUT";
interface Person {
  code: string; name: string | null; photoUrl: string | null; known: boolean;
  periods: Record<PeriodKey, Slot>; offHours: { scans: Scan[]; passes: Pass[] };
  scans: Scan[]; passes: Pass[]; noScanIns: number[]; flags: string[];
  firstScan: string | null; lastScan: string | null; firstIn: string | null; lastOut: string | null;
}
interface Win { from: number; to: number }
interface Compare {
  day: string; summary: { scanned: number; seenByCamera: number; both: number; flagged: number; offHours: number; devices: number };
  periods: { IN: Win; BREAK: Win; OUT: Win }; people: Person[];
}
interface Device { id: number; alias: string; ip: string; floor: string | null; records: number | null; clockOffsetSec: number | null; lastPullAt: string | null; lastOkAt: string | null; lastError: string | null; stored: number; lastPunchAt: string | null }

interface PullState {
  auto: boolean; dailyAt: string; requestedAt: string | null; running: boolean; nextAutoAt: string | null; pullerSeenAt: string | null;
  lastStartedAt: string | null; lastFinishedAt: string | null; lastReason: "manual" | "auto" | null; lastInserted: number | null; lastFailed: number | null;
  progress: { percent: number; done: number; total: number; current: string | null; updatedAt: string } | null;
}
const dt = (s: string) => new Date(s).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** "ดึงข้อมูลตอนนี้" + optional once-a-day auto pull. The puller on the server polls the API for this. */
function PullControl({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const st = useQuery({
    queryKey: ["attendance", "pull"], queryFn: () => api<PullState>("/api/attendance/pull"),
    refetchInterval: (q) => (q.state.data?.running || q.state.data?.requestedAt ? 1_500 : 30_000),
  });
  const set = (d: PullState) => qc.setQueryData(["attendance", "pull"], d);
  const now = useMutation({ mutationFn: () => api<PullState>("/api/attendance/pull/now", { method: "POST" }), onSuccess: set });
  const save = useMutation({ mutationFn: (b: { auto: boolean; dailyAt: string }) => api<PullState>("/api/attendance/pull", { method: "PUT", json: b }), onSuccess: set });
  const d = st.data;
  const busy = !!d && (d.running || !!d.requestedAt);
  const [time, setTime] = useState("");
  useEffect(() => { if (d && !time) setTime(d.dailyAt); }, [d, time]);
  // refresh the table when a run finishes; keep the lock up a moment to show the result
  const lastFin = useRef<string | null | undefined>(undefined);
  const [justDone, setJustDone] = useState(false);
  useEffect(() => {
    if (!d) return;
    if (lastFin.current !== undefined && d.lastFinishedAt !== lastFin.current) {
      onDone();
      setJustDone(true);
      const t = setTimeout(() => setJustDone(false), 2500);
      lastFin.current = d.lastFinishedAt;
      return () => clearTimeout(t);
    }
    lastFin.current = d.lastFinishedAt;
  }, [d, onDone]);
  const offline = !!d && (!d.pullerSeenAt || Date.now() - new Date(d.pullerSeenAt).getTime() > 120_000);
  const last = d?.lastFinishedAt && (d.lastFailed ?? 0) >= 0
    ? `ดึงล่าสุด ${dt(d.lastFinishedAt)} (${d.lastReason === "auto" ? "อัตโนมัติ" : "กดเอง"}) · ใหม่ ${d.lastInserted ?? 0} รายการ${d.lastFailed ? ` · เครื่องผิดพลาด ${d.lastFailed}` : ""}`
    : d?.lastFinishedAt ? `ดึงล่าสุด ${dt(d.lastFinishedAt)} ไม่สำเร็จ` : "ยังไม่เคยดึง";

  // lock the page while a pull runs (unless the puller is not there to do it)
  // "ซ่อน" hides the lock until this run finishes (keyed by the previous run's finish time)
  const [hidden, setHidden] = useState<string | null | undefined>(undefined);
  const runKey = d?.lastFinishedAt ?? null;
  const stalled = !!d?.progress && Date.now() - new Date(d.progress.updatedAt).getTime() > 90_000;
  const lock = (busy && !offline && hidden !== runKey) || justDone;
  const pct = justDone ? 100 : d?.progress?.percent ?? 0;

  return (
    <div className="flex items-center gap-2">
      {lock && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 backdrop-blur-sm">
          <div className="w-[26rem] max-w-[92vw] rounded-2xl border border-ink-700 bg-ink-900 p-5 text-sm shadow-2xl">
            <div className="flex items-center gap-2 font-display font-semibold text-cream">
              <CloudDownload size={18} className={clsx("text-gold-400", !justDone && "animate-pulse")} />
              {justDone ? "ดึงข้อมูลสแกนเสร็จแล้ว" : d?.running ? "กำลังดึงข้อมูลจากเครื่องสแกน" : "รอตัวดึงข้อมูลเริ่มทำงาน…"}
            </div>
            <div className="mt-4 flex items-end justify-between">
              <span className="text-xs text-zinc-400">
                {justDone
                  ? (d?.lastFailed ?? 0) < 0 ? "ดึงไม่สำเร็จ" : `ได้สแกนใหม่ ${d?.lastInserted ?? 0} รายการ${d?.lastFailed ? ` · เครื่องผิดพลาด ${d.lastFailed}` : ""}`
                  : d?.progress ? `เครื่อง ${Math.min(d.progress.done + (d.progress.current ? 1 : 0), d.progress.total)}/${d.progress.total}${d.progress.current ? ` · กำลังอ่าน ${d.progress.current}` : ""}` : "กำลังเชื่อมต่อ…"}
              </span>
              <span className="font-mono text-2xl text-gold-300">{pct}%</span>
            </div>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-ink-800">
              <div className="h-full rounded-full bg-gold-500 transition-all duration-700" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-3 flex items-center text-xs text-zinc-500">
              <span>{stalled ? "เครื่องสแกนตอบช้า / ไม่ตอบ — ระบบจะข้ามไปเครื่องถัดไปเอง" : "อ่านทีละเครื่อง เครื่องที่มีประวัติเยอะจะใช้เวลานานกว่า"}</span>
              {!justDone && <button className="ml-auto shrink-0 rounded px-2 py-1 text-zinc-400 hover:bg-ink-800 hover:text-cream" onClick={() => setHidden(runKey)} title="ปิดหน้าต่างนี้ — ระบบยังดึงข้อมูลต่อเบื้องหลัง">ซ่อน</button>}
            </div>
          </div>
        </div>
      )}
      <Button variant="gold" disabled={!d || busy || now.isPending} onClick={() => now.mutate()}
        title={offline ? "ตัวดึงข้อมูลบนเซิร์ฟเวอร์ไม่ตอบสนอง (pull.py ไม่ได้ทำงาน)" : last}>
        <CloudDownload size={14} className={clsx(busy && "animate-pulse")} />
        {d?.running ? "กำลังดึงข้อมูล…" : d?.requestedAt ? "รอตัวดึงข้อมูล…" : "ดึงข้อมูลสแกนตอนนี้"}
      </Button>
      <label className="flex items-center gap-1.5 text-zinc-400" title="ดึงข้อมูลจากเครื่องสแกนทุกเครื่องอัตโนมัติวันละครั้งตามเวลาที่เลือก">
        <input type="checkbox" checked={!!d?.auto} disabled={!d || save.isPending} onChange={(e) => save.mutate({ auto: e.target.checked, dailyAt: time || d!.dailyAt })} />
        อัตโนมัติทุกวันเวลา
      </label>
      <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="!w-28"
        onBlur={() => { if (d && time && time !== d.dailyAt) save.mutate({ auto: d.auto, dailyAt: time }); }} />
      <span className={clsx("hidden lg:inline", offline ? "text-red-400" : "text-zinc-500")}>
        {offline ? "ตัวดึงข้อมูลไม่ทำงาน" : d?.auto && d.nextAutoAt ? `รอบถัดไป ${dt(d.nextAutoAt)}` : last}
      </span>
    </div>
  );
}

const FLAG: Record<string, { label: string; cls: string; tip: string }> = {
  NO_SCAN_DAY: { label: "กล้องเห็น · ไม่มีสแกนทั้งวัน", cls: "bg-red-900/40 text-red-300 ring-red-800/60", tip: "กล้องจดจำได้ว่าเข้า/ออกอาคาร แต่ไม่มีสแกนนิ้วเลยทั้งวัน" },
  NO_SCAN_AFTER_IN: { label: "อาจลืมสแกน", cls: "bg-amber-900/40 text-amber-300 ring-amber-800/60", tip: "กล้องเห็นเข้าอาคาร แต่ไม่มีสแกนตั้งแต่ 10 นาทีก่อนถึง 30 นาทีหลัง" },
  SCAN_BEFORE_CAMERA: { label: "สแกนก่อนกล้องเห็น", cls: "bg-sky-900/40 text-sky-300 ring-sky-800/60", tip: "สแกนครั้งแรกก่อนกล้องเห็นเข้าอาคารเกิน 5 นาที (เข้าทางอื่น / กล้องจดจำได้ทีหลัง / นาฬิกาเครื่องสแกน)" },
  OFF_HOURS: { label: "เข้าออกนอกเวลา", cls: "bg-violet-900/40 text-violet-300 ring-violet-800/60", tip: "มีสแกนหรือกล้องเห็นนอกช่วงเข้างาน / พักเบรค / เลิกงาน" },
};
const PERIOD_COLS: { key: PeriodKey; label: string }[] = [
  { key: "IN", label: "1. เข้างาน" }, { key: "BREAK_OUT", label: "2. ออกพักเบรค" }, { key: "BREAK_IN", label: "3. เข้างานหลังเบรค" }, { key: "OUT", label: "4. เลิกงาน" },
];
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const hm = (s: string) => new Date(s).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false });
const hms = (s: string) => new Date(s).toLocaleTimeString("th-TH", { hour12: false });
function Img({ src, className }: { src: string | null; className?: string }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <div className={clsx("bg-ink-800", className)} />;
  return <img src={API_URL + src} onError={() => setBad(true)} className={clsx("object-cover", className)} alt="" loading="lazy" />;
}

function ScanChip({ x }: { x: Scan }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-ink-800 px-1.5 py-0.5 text-xs" title={`สแกน ${hms(x.at)} · เครื่อง ${x.device}${x.clockOffsetSec ? ` (นาฬิกาเครื่อง ${x.clockOffsetSec > 0 ? "เร็ว" : "ช้า"} ${Math.abs(x.clockOffsetSec)} วิ)` : ""}`}>
      <Fingerprint size={11} className="text-gold-400" /><span className="font-mono text-cream">{hm(x.at)}</span><span className="text-zinc-500">{x.device}</span>
    </span>
  );
}
function PassChip({ x, warn, onOpen }: { x: Pass; warn?: boolean; onOpen: (p: Pass) => void }) {
  return (
    <button disabled={!x.recorded} onClick={() => onOpen(x)}
      className={clsx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ring-1", warn ? "ring-amber-700/70" : "ring-ink-700", x.recorded && "hover:bg-ink-800")}
      title={`กล้อง${x.direction === "IN" ? "เห็นเข้า" : "เห็นออก"} ${hms(x.first)}–${hms(x.last)} · ${x.deviceNo}${x.count > 1 ? ` · รวม ${x.count} ครั้ง` : ""}${x.status === "UNCERTAIN" ? " · ไม่แน่ใจ" : ""}${x.byScan ? " · ยืนยันด้วยสแกนนิ้ว" : ""}${x.byCam ? " · ยืนยันด้วย 2 กล้อง" : ""}${x.recorded ? " · กดเพื่อดูวิดีโอ" : ""}`}>
      {x.direction === "IN" ? <ArrowDownToLine size={11} className="text-emerald-400" /> : <ArrowUpFromLine size={11} className="text-sky-400" />}
      <span className={clsx("font-mono", x.status === "UNCERTAIN" ? "text-zinc-400" : "text-cream")}>{hm(x.at)}</span>
      {x.recorded && <Film size={10} className="text-zinc-500" />}
    </button>
  );
}

export function AttendanceCompare() {
  const [clip, setClip] = useState<{ cameraId: number; at: number; title: string } | null>(null);
  const [day, setDay] = useState(toLocalInput(new Date()).slice(0, 10));
  const [uncertain, setUncertain] = useState(false);
  const [filter, setFilter] = useState<"all" | "flagged" | "off" | "camera">("all");
  const [q, setQ] = useState("");
  const data = useQuery({ queryKey: ["attendance", "compare", day, uncertain], queryFn: () => api<Compare>(`/api/attendance/compare?day=${day}${uncertain ? "&uncertain=1" : ""}`), refetchInterval: 60_000 });
  const devices = useQuery({ queryKey: ["attendance", "devices"], queryFn: () => api<Device[]>("/api/attendance/devices"), refetchInterval: 60_000 });
  const [showDevices, setShowDevices] = useState(false);
  const { refetch: refetchData } = data, { refetch: refetchDevices } = devices;
  const refreshAll = useCallback(() => { refetchData(); refetchDevices(); }, [refetchData, refetchDevices]);

  const ql = q.trim().toLowerCase();
  const rows = useMemo(() => (data.data?.people ?? []).filter((p) =>
    (filter === "all" || (filter === "flagged" ? p.flags.some((f) => f !== "OFF_HOURS") : filter === "off" ? p.flags.includes("OFF_HOURS") : p.passes.length > 0))
    && (!ql || p.code.toLowerCase().includes(ql) || (p.name ?? "").toLowerCase().includes(ql))), [data.data, filter, ql]);
  const s = data.data?.summary;
  const devErr = (devices.data ?? []).filter((d) => d.lastError);
  const lastPull = (devices.data ?? []).map((d) => d.lastOkAt).filter(Boolean).sort().at(-1);
  const openVideo = (p: Pass, who?: Person) => setClip({ cameraId: p.cameraId, at: new Date(p.at).getTime(), title: `${who?.name ?? ""} ${who?.code ?? ""} · ${p.direction === "IN" ? "เข้า" : "ออก"} ${p.deviceNo}` });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="เทียบเวลาเข้างาน" subtitle="สแกนนิ้ว (ZKTeco ทุกชั้น) เทียบกับกล้องหน้าอาคาร · ใช้ตรวจลืมสแกน / เวลาไม่ตรง" />

      <div className="flex flex-wrap items-center gap-2 px-5 pb-3 text-xs">
        <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="!w-40" />
        <div className="flex overflow-hidden rounded-lg border border-ink-700">
          {([["all", "ทั้งหมด"], ["flagged", "มีธงต้องตรวจ"], ["off", "เข้าออกนอกเวลา"], ["camera", "กล้องเห็น"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={clsx("px-3 py-1.5", filter === k ? "bg-gold-500 text-onaccent" : "text-zinc-400 hover:bg-ink-800")}>{l}</button>
          ))}
        </div>
        <Input placeholder="รหัส / ชื่อพนักงาน" value={q} onChange={(e) => setQ(e.target.value)} className="!w-48" />
        <label className="flex items-center gap-1.5 text-zinc-400" title="นับรายการกล้องสถานะ 'ไม่แน่ใจ' ด้วย (จับคนได้มากขึ้น แต่อาจระบุคนผิดบ้าง)">
          <input type="checkbox" checked={uncertain} onChange={(e) => setUncertain(e.target.checked)} /> รวมกล้อง "ไม่แน่ใจ"
        </label>
        <Button variant="ghost" onClick={refreshAll} title="โหลดตารางใหม่ (ไม่ได้ดึงจากเครื่องสแกน)"><RefreshCw size={13} /></Button>
        <PullControl onDone={refreshAll} />
        <button onClick={() => setShowDevices((v) => !v)} className="ml-auto flex items-center gap-1.5 text-zinc-400 hover:text-cream">
          <Fingerprint size={14} className={devErr.length ? "text-amber-400" : "text-emerald-400"} />
          เครื่องสแกน {devices.data?.length ?? 0} เครื่อง{devErr.length ? ` · ผิดพลาด ${devErr.length}` : ""}{lastPull && ` · ดึงล่าสุด ${hm(lastPull)}`}
        </button>
      </div>

      {showDevices && (
        <Card className="mx-5 mb-3 overflow-auto p-0 text-xs">
          <table className="w-full">
            <thead className="bg-ink-850 text-left text-zinc-500"><tr><th className="px-3 py-1.5 font-normal">เครื่อง</th><th className="font-normal">IP</th><th className="font-normal">ประวัติในเครื่อง</th><th className="font-normal">เก็บในระบบ</th><th className="font-normal">สแกนล่าสุด</th><th className="font-normal" title="นาฬิกาเครื่องสแกน − นาฬิกาเซิร์ฟเวอร์">นาฬิกาเครื่อง</th><th className="font-normal">ดึงล่าสุด</th></tr></thead>
            <tbody>
              {devices.data?.map((d) => (
                <tr key={d.id} className="border-t border-ink-800/60">
                  <td className="px-3 py-1 text-cream">ชั้น {d.floor} · {d.alias}</td>
                  <td className="font-mono text-zinc-400">{d.ip}</td>
                  <td>{d.records?.toLocaleString() ?? "-"}</td>
                  <td>{d.stored.toLocaleString()}</td>
                  <td>{d.lastPunchAt ? new Date(d.lastPunchAt).toLocaleString("th-TH", { hour12: false }) : "-"}</td>
                  <td className={clsx(Math.abs(d.clockOffsetSec ?? 0) > 30 && "text-amber-400")}>{d.clockOffsetSec == null ? "-" : `${d.clockOffsetSec > 0 ? "เร็ว" : d.clockOffsetSec < 0 ? "ช้า" : "ตรง"} ${Math.abs(d.clockOffsetSec)} วิ`}</td>
                  <td className={clsx(d.lastError && "text-red-400")} title={d.lastError ?? ""}>{d.lastError ? "ผิดพลาด" : d.lastOkAt ? hm(d.lastOkAt) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {s && (
        <div className="grid grid-cols-2 gap-2 px-5 pb-3 text-xs sm:grid-cols-5">
          <Card className="p-3"><div className="text-zinc-500">สแกนนิ้ววันนี้</div><div className="text-xl text-cream">{s.scanned.toLocaleString()} <span className="text-xs text-zinc-500">คน</span></div></Card>
          <Card className="p-3"><div className="text-zinc-500">กล้องจดจำได้</div><div className="text-xl text-cream">{s.seenByCamera.toLocaleString()} <span className="text-xs text-zinc-500">คน</span></div></Card>
          <Card className="p-3"><div className="text-zinc-500">มีทั้งสแกนและกล้อง</div><div className="text-xl text-cream">{s.both.toLocaleString()} <span className="text-xs text-zinc-500">คน</span></div></Card>
          <Card className="p-3"><div className="text-zinc-500">มีธงต้องตรวจ</div><div className={clsx("text-xl", s.flagged ? "text-amber-300" : "text-cream")}>{s.flagged.toLocaleString()} <span className="text-xs text-zinc-500">คน</span></div></Card>
          <Card className="p-3"><div className="text-zinc-500">เข้าออกนอกเวลา</div><div className={clsx("text-xl", s.offHours ? "text-violet-300" : "text-cream")}>{s.offHours.toLocaleString()} <span className="text-xs text-zinc-500">คน</span></div></Card>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
        {data.isLoading ? <div className="p-6 text-sm text-zinc-500">กำลังโหลด…</div> : (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-ink-850 text-left text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-normal" /><th className="font-normal">พนักงาน</th>
                  {PERIOD_COLS.map((c) => {
                    const w = data.data?.periods;
                    const win = !w ? "" : c.key === "IN" ? `${hhmm(w.IN.from)}–${hhmm(w.IN.to)}` : c.key === "OUT" ? `${hhmm(w.OUT.from)}–${hhmm(w.OUT.to)}` : `${hhmm(w.BREAK.from)}–${hhmm(w.BREAK.to)}`;
                    return <th key={c.key} className="font-normal"><div>{c.label}</div><div className="text-[10px] text-zinc-600">{win}</div></th>;
                  })}
                  <th className="font-normal">เข้าออกนอกเวลา</th>
                  <th className="pr-3 font-normal">ต้องตรวจ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.code} className="border-t border-ink-800/60 align-top">
                    <td className="w-14 px-3 py-2"><Img src={p.photoUrl} className="h-12 w-9 rounded" /></td>
                    <td className="py-2 pr-2">
                      <div className={clsx(p.known ? "text-cream" : "text-zinc-500")}>{p.name ?? "ไม่พบในรายชื่อพนักงาน"}</div>
                      <div className="text-xs text-zinc-500">{p.code}</div>
                    </td>
                    {PERIOD_COLS.map((c) => {
                      const slot = p.periods[c.key];
                      return (
                        <td key={c.key} className="py-2 pr-2">
                          <div className="flex flex-col items-start gap-1">
                            {slot.scan ? <ScanChip x={slot.scan} /> : <span className="text-[11px] text-zinc-600">ไม่มีสแกน</span>}
                            {slot.camera && <PassChip x={slot.camera} warn={p.noScanIns.includes(slot.camera.eventId)} onOpen={(x) => openVideo(x, p)} />}
                          </div>
                        </td>
                      );
                    })}
                    <td className="py-2 pr-2">
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {[...p.offHours.scans.map((x) => ({ t: x.at, el: <ScanChip key={`s${x.at}`} x={x} /> })),
                          ...p.offHours.passes.map((x) => ({ t: x.at, el: <PassChip key={`p${x.eventId}`} x={x} warn={p.noScanIns.includes(x.eventId)} onOpen={(y) => openVideo(y, p)} /> }))]
                          .sort((a, b) => a.t.localeCompare(b.t)).map((x) => x.el)}
                        {!p.offHours.scans.length && !p.offHours.passes.length && <span className="text-[11px] text-zinc-600">-</span>}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-col items-start gap-1">
                        {p.flags.map((f) => <span key={f} title={FLAG[f]?.tip} className={clsx("rounded px-1.5 py-0.5 text-[11px] ring-1", FLAG[f]?.cls)}>{FLAG[f]?.label ?? f}</span>)}
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-zinc-500">{filter === "flagged" ? "ไม่มีรายการที่ต้องตรวจในวันนี้" : "ไม่มีข้อมูล"}</td></tr>}
              </tbody>
            </table>
            <div className="space-y-0.5 border-t border-ink-800 px-3 py-2 text-xs text-zinc-500">
              <div>ช่วงเวลา: เข้างาน = สแกนแรกของช่วงเช้า · ออกพักเบรค / เข้างานหลังเบรค = สแกนแรก / สุดท้ายของช่วงพัก (ห่างกันอย่างน้อย 10 นาที) · เลิกงาน = สแกนสุดท้ายหลัง 16:00 (รวม OT) · สแกนซ้ำภายใน 5 นาทีไม่นับ · ที่เหลือ = เข้าออกนอกเวลา</div>
              <div>สแกนนิ้วดึงจากเครื่อง ZKTeco ทุก 10 นาที (อ่านอย่างเดียว) · เวลาเป็นเวลาของเครื่องสแกน — แต่ละเครื่องคลาดได้ประมาณ ±40 วินาที ดูในรายการเครื่องสแกน</div>
              <div>กล้อง: นับเฉพาะ "ตรงกัน" (และ "ไม่แน่ใจ" ถ้าเลือก) ไม่รวมคนที่ยืนอยู่ในกรอบ · รวมการผ่านของคนเดียวกันภายใน 30 นาที · ลูกศรเขียว = เข้า ฟ้า = ออก · กดเวลาที่มี 🎞 เพื่อดูวิดีโอ</div>
              <div>กล้องยังจดจำได้ไม่ครบทุกคน — "กล้องไม่เห็น" ไม่ได้แปลว่าไม่ได้มา ใช้ธงเป็นจุดเริ่มตรวจ ไม่ใช่คำตัดสิน</div>
            </div>
          </Card>
        )}
      </div>
      {clip && <ClipDialog cameraId={clip.cameraId} at={clip.at} title={clip.title} onClose={() => setClip(null)} />}
    </div>
  );
}
