/**
 * ดูย้อนหลัง / Playback — footage recorded by our own recorder (not the NVR).
 *
 * Each day is a list of ~1-minute MP4 files per camera. Several cameras sit in a layout grid (like
 * the layout page) and play on ONE clock: the page owns the playhead time `t`; every tile maps `t`
 * to its own file + offset and re-seeks only when it drifts. The clock follows the selected tile's
 * real playback (so buffering doesn't run ahead) and falls back to wall time. All seeking happens
 * on the day / hour timelines — the per-file native progress bar is hidden on purpose.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import GridLayout, { WidthProvider, type Layout as RglLayout } from "react-grid-layout";
import { Camera as CameraIcon, ChevronDown, ChevronRight, Download, LayoutGrid, Orbit, Pause, Pencil, Play, Plus, Rewind, FastForward, Square, Circle, X } from "lucide-react";
import { FisheyeView, parseFisheye } from "../components/FisheyeView";
import clsx from "clsx";
import { useSearchParams } from "react-router-dom";
import { api, API_URL, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Camera, LayoutItem, VideoLayout } from "../types";
import { Button, Card, Field, Input, Modal, PageHeader, Select, StatusDot, fmtDate, toLocalInput } from "../components/ui";

interface RecCamera {
  id: number; deviceNo: string; name: string; status: string; recordEnabled: boolean; recordStream: string; fisheye: string | null;
  job: { running: boolean; since: string | null; restarts: number; lastError: string | null } | null;
  files: number; bytes: number; recordedMs: number; oldest: string | null; newest: string | null;
}
interface RecStatus {
  recorder: { alive: boolean; updatedAt: string; recordingsDir: string } | null;
  config: { segmentSeconds: number; retentionDays: number; minFreeGb: number };
  disk: { totalBytes: number; freeBytes: number } | null;
  cameras: RecCamera[];
}
interface Seg { id: number; startedAt: string; endedAt: string; durationMs: number; sizeBytes: number; videoCodec: string | null; width: number | null; height: number | null; url: string }
interface Span { s: number; e: number }

const HOUR = 3600_000;
const fmtBytes = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(0)} MB`);
const fmtTime = (t: number, sec = true) => new Date(t).toLocaleTimeString("th-TH", { hour12: false, hour: "2-digit", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}) });
const localDay = (d: Date) => toLocalInput(d).slice(0, 10);
const dayStart = (day: string) => new Date(`${day}T00:00:00`).getTime();

/** Merges back-to-back files into continuous spans (gaps ≤ 3 s are treated as continuous). */
function toSpans(segs: Seg[]): Span[] {
  const out: Span[] = [];
  for (const g of segs) {
    const s = new Date(g.startedAt).getTime();
    const e = new Date(g.endedAt).getTime();
    const last = out.at(-1);
    if (last && s - last.e <= 3000) last.e = Math.max(last.e, e);
    else out.push({ s, e });
  }
  return out;
}

function Timeline({ from, to, spans, cursor, onSeek, tickMs, label }: {
  from: number; to: number; spans: Span[]; cursor: number | null; onSeek: (t: number) => void; tickMs: number; label: (t: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const len = to - from;
  const pct = (t: number) => `${((Math.min(Math.max(t, from), to) - from) / len) * 100}%`;
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return from + ((clientX - r.left) / r.width) * len;
  };
  const ticks: number[] = [];
  for (let t = Math.ceil(from / tickMs) * tickMs; t <= to; t += tickMs) ticks.push(t);
  return (
    <div className="select-none">
      <div
        ref={ref}
        className="relative h-9 cursor-pointer overflow-hidden rounded border border-ink-800 bg-ink-900"
        onClick={(e) => onSeek(at(e.clientX))}
        onMouseMove={(e) => setHover(at(e.clientX))}
        onMouseLeave={() => setHover(null)}
      >
        {spans.filter((s) => s.e > from && s.s < to).map((s, i) => (
          <div key={i} className="absolute inset-y-1 rounded-sm bg-gold-500/70" style={{ left: pct(s.s), width: `calc(${pct(s.e)} - ${pct(s.s)})`, minWidth: 1 }} />
        ))}
        {ticks.map((t) => <div key={t} className="absolute inset-y-0 w-px bg-ink-700/70" style={{ left: pct(t) }} />)}
        {cursor !== null && cursor >= from && cursor <= to && <div className="absolute inset-y-0 w-0.5 bg-red-500" style={{ left: pct(cursor) }} />}
        {hover !== null && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px bg-cream/60" style={{ left: pct(hover) }} />
            <div className="pointer-events-none absolute top-0 rounded bg-black/80 px-1 text-[10px] text-cream" style={{ left: pct(hover) }}>{fmtTime(hover)}</div>
          </>
        )}
      </div>
      <div className="relative mt-0.5 h-4 text-[10px] text-zinc-500">
        {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: pct(t) }}>{label(t)}</span>)}
      </div>
    </div>
  );
}

function StatusPanel({ status, isAdmin, open, onToggle }: { status: RecStatus | undefined; isAdmin: boolean; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const allCams = useQuery({ queryKey: ["cameras", "all"], queryFn: () => api<Camera[]>("/api/cameras"), enabled: isAdmin });
  const [addId, setAddId] = useState("");
  const toggle = useMutation({
    mutationFn: (v: { id: number; recordEnabled: boolean }) => api(`/api/recordings/cameras/${v.id}`, { method: "PATCH", json: { recordEnabled: v.recordEnabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recordings", "status"] }),
  });
  const rec = status?.recorder;
  const used = status?.cameras.reduce((a, c) => a + c.bytes, 0) ?? 0;
  return (
    <Card className="mx-5 mb-2 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <button onClick={onToggle} className="flex items-center gap-1 text-zinc-300 hover:text-cream" title={open ? "พับตารางกล้อง" : "แสดงตารางกล้อง"}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} กล้องที่บันทึก ({status?.cameras.filter((c) => c.recordEnabled).length ?? 0})
        </button>
        <span className="flex items-center gap-1.5">
          <span className={clsx("h-2 w-2 rounded-full", rec?.alive ? "bg-emerald-400" : "bg-red-500")} />
          ตัวบันทึก {rec?.alive ? "ทำงาน" : "ไม่ทำงาน"}
        </span>
        <span className="text-zinc-400">ไฟล์ละ {status?.config.segmentSeconds}s · เก็บ {status?.config.retentionDays} วัน · กันพื้นที่ ≥ {status?.config.minFreeGb} GB</span>
        {status?.disk && <span className="text-zinc-400">ใช้ไป {fmtBytes(used)} · ดิสก์ว่าง {fmtBytes(status.disk.freeBytes)} / {fmtBytes(status.disk.totalBytes)}</span>}
      </div>
      {open && <>
      <table className="mt-2 w-full">
        <thead className="text-left text-zinc-500">
          <tr><th className="py-1 font-normal">กล้อง</th><th className="font-normal">สถานะบันทึก</th><th className="font-normal">ไฟล์</th><th className="font-normal">ขนาด</th><th className="font-normal">ช่วงที่มี</th><th /></tr>
        </thead>
        <tbody>
          {status?.cameras.map((c) => (
            <tr key={c.id} className="border-t border-ink-800/60">
              <td className="py-1"><StatusDot status={c.status} /> <span className="text-cream">{c.deviceNo}</span> <span className="text-zinc-500">{c.name}</span></td>
              <td>
                {!c.recordEnabled ? <span className="text-zinc-500">ปิด</span>
                  : c.job?.running ? <span className="text-emerald-400">● กำลังบันทึก ({c.recordStream})</span>
                  : <span className="text-amber-400" title={c.job?.lastError ?? ""}>รอเริ่ม / เชื่อมต่อใหม่{c.job?.restarts ? ` (${c.job.restarts})` : ""}</span>}
                {c.job?.lastError && c.recordEnabled && !c.job.running && <div className="max-w-md truncate text-[10px] text-red-400">{c.job.lastError}</div>}
              </td>
              <td>{c.files.toLocaleString()}</td>
              <td>{fmtBytes(c.bytes)}</td>
              <td className="text-zinc-400">{c.oldest ? `${fmtDate(c.oldest)} – ${fmtDate(c.newest)}` : "-"}</td>
              <td className="text-right">
                {isAdmin && (
                  <button className="rounded px-2 py-0.5 text-zinc-400 hover:bg-ink-800 hover:text-cream" onClick={() => toggle.mutate({ id: c.id, recordEnabled: !c.recordEnabled })}>
                    {c.recordEnabled ? <><Square size={11} className="inline" /> หยุดบันทึก</> : <><Circle size={11} className="inline text-red-500" /> เริ่มบันทึก</>}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && (
        <div className="mt-2 flex items-center gap-2">
          <Select className="w-80" value={addId} onChange={(e) => setAddId(e.target.value)}>
            <option value="">+ เพิ่มกล้องที่จะบันทึก…</option>
            {allCams.data?.filter((c) => c.isEnabled && !status?.cameras.some((r) => r.id === c.id && r.recordEnabled)).map((c) => (
              <option key={c.id} value={c.id}>{c.deviceNo} {c.name}</option>
            ))}
          </Select>
          <Button disabled={!addId || toggle.isPending} onClick={() => { toggle.mutate({ id: Number(addId), recordEnabled: true }); setAddId(""); }}>เริ่มบันทึก</Button>
        </div>
      )}
      </>}
    </Card>
  );
}


// ── multi-camera synchronized playback ──────────────────────────────────────────────────────
const Grid = WidthProvider(GridLayout);
const COLS = 12;
const ROWS = 12; // the grid always fills the stage height: rowHeight is derived from it
const LAYOUT_KEY = "playback.layout.v1";
const PANEL_KEY = "playback.panelOpen";

const segAt = (segs: Seg[], t: number) => segs.find((g) => new Date(g.startedAt).getTime() <= t && t < new Date(g.endedAt).getTime()) ?? null;

/** Even tiling for n cameras on the 12×12 grid (used when cameras are added/removed). */
function autoTile(ids: number[]): LayoutItem[] {
  const n = ids.length;
  const per = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : n <= 9 ? 3 : 4; // columns
  const rows = n <= 1 ? 1 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 6 ? 2 : n <= 9 ? 3 : 4;
  const w = Math.floor(COLS / per), h = Math.floor(ROWS / rows);
  return ids.map((cameraId, i) => ({ cameraId, x: (i % per) * w, y: Math.floor(i / per) * h, w, h }));
}
const loadSaved = (): LayoutItem[] => {
  try { const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
};

interface TimeReport { camId: number; t: number; at: number }

/** One camera tile: plays whichever file covers the shared time `t`, re-seeking only on drift. */
function RecTile({ cam, segs, t, playing, rate, selected, editing, onSelect, onRemove, onReport, register }: {
  cam: RecCamera; segs: Seg[]; t: number | null; playing: boolean; rate: number; selected: boolean; editing: boolean;
  onSelect: () => void; onRemove: () => void; onReport: (r: TimeReport) => void; register: (id: number, v: HTMLVideoElement | null) => void;
}) {
  const vref = useRef<HTMLVideoElement | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const seg = t === null ? null : segAt(segs, t);
  const start = seg ? new Date(seg.startedAt).getTime() : 0;
  const cal = parseFisheye(cam.fisheye);
  const [dewarp, setDewarp] = useState(true);
  const getVideo = useCallback(() => vref.current, []);

  // keep in step with the shared clock
  useEffect(() => {
    const v = vref.current;
    if (!v || !seg || t === null || v.readyState < 1) return;
    const want = (t - start) / 1000;
    const tolerance = playing ? Math.max(0.8, 0.4 * rate) : 0.15;
    if (Math.abs(v.currentTime - want) > tolerance) v.currentTime = Math.max(0, want);
    if (v.playbackRate !== rate) v.playbackRate = rate;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }, [t, playing, rate, seg?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div onMouseDown={onSelect} className={clsx("group relative h-full w-full overflow-hidden rounded-lg border bg-black", selected ? "border-gold-500" : "border-ink-800")}>
      {seg ? (
        <video
          key={seg.id}
          ref={(el) => { vref.current = el; register(cam.id, el); }}
          src={API_URL + seg.url}
          crossOrigin="anonymous"
          muted
          playsInline
          className={clsx("h-full w-full object-contain", cal && dewarp && "invisible")}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            v.currentTime = Math.max(0, ((tRef.current ?? start) - start) / 1000);
            v.playbackRate = rate;
            if (playing) v.play().catch(() => {});
          }}
          onTimeUpdate={(e) => { if (!e.currentTarget.paused) onReport({ camId: cam.id, t: start + e.currentTarget.currentTime * 1000, at: performance.now() }); }}
        />
      ) : (
        <div className="grid h-full place-items-center text-xs text-zinc-600">{t === null ? "เลือกเวลาบนแถบด้านบน" : "ไม่มีภาพช่วงเวลานี้"}</div>
      )}
      {seg && cal && dewarp && <div className="drag-cancel absolute inset-0"><FisheyeView getVideo={getVideo} cal={cal} /></div>}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1.5 bg-gradient-to-b from-black/80 to-transparent px-2 py-1 text-[11px] text-zinc-200">
        <StatusDot status={cam.status} />
        <span className="font-medium">{cam.deviceNo}</span>
        <span className="truncate text-zinc-400">{cam.name}</span>
      </div>
      <div className="absolute right-1 top-1 z-10 flex gap-1 opacity-0 group-hover:opacity-100">
        {seg && cal && (
          <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setDewarp((d) => !d)} className="drag-cancel flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:text-gold-300">
            <Orbit size={12} /> {dewarp ? "ภาพเต็มวง" : "หมุนดูภาพ"}
          </button>
        )}
        {editing && <button onMouseDown={(e) => e.stopPropagation()} onClick={onRemove} className="drag-cancel rounded bg-black/70 p-1 text-zinc-300 hover:text-red-300" title="เอาออก"><X size={12} /></button>}
      </div>
    </div>
  );
}

export function Recordings() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const status = useQuery({ queryKey: ["recordings", "status"], queryFn: () => api<RecStatus>("/api/recordings/status"), refetchInterval: 15000 });
  const recCams = useMemo(() => status.data?.cameras.filter((c) => c.files > 0 || c.recordEnabled) ?? [], [status.data]);
  const camById = useMemo(() => new Map(recCams.map((c) => [c.id, c])), [recCams]);
  const savedLayouts = useQuery({ queryKey: ["layouts"], queryFn: () => api<VideoLayout[]>("/api/layouts") });

  const [panelOpen, setPanelOpen] = useState(() => { try { return localStorage.getItem(PANEL_KEY) === "1"; } catch { return false; } });
  const togglePanel = () => setPanelOpen((o) => { try { localStorage.setItem(PANEL_KEY, o ? "0" : "1"); } catch {} return !o; });

  // Deep link from other pages (e.g. บันทึกเข้า-ออก): /recordings?cam=<id>&t=<epoch ms>
  const [params, setParams] = useSearchParams();
  const linkT = params.get("t") ? Number(params.get("t")) : null;
  const linkCam = params.get("cam") ? Number(params.get("cam")) : null;
  const [day, setDay] = useState(localDay(linkT ? new Date(linkT) : new Date()));
  const from = dayStart(day);
  const to = from + 24 * HOUR;
  const isToday = day === localDay(new Date());

  // ── layout (which cameras, where) — remembered per browser ──
  const [items, setItems] = useState<LayoutItem[]>(() => {
    const saved = loadSaved();
    if (linkCam && !saved.some((i) => i.cameraId === linkCam)) return autoTile([...saved.map((i) => i.cameraId), linkCam]);
    return saved;
  });
  const [editing, setEditing] = useState(false);
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(items)); } catch {} }, [items]);
  // drop cameras that no longer have recordings; start with the first recorded camera
  useEffect(() => {
    if (!status.data) return;
    const kept = items.filter((i) => camById.has(i.cameraId));
    if (kept.length !== items.length) setItems(kept.length ? kept : []);
    else if (!items.length && recCams[0]) setItems(autoTile([recCams[0].id]));
  }, [status.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = items.map((i) => i.cameraId);
  const addCam = (id: number) => { if (!ids.includes(id)) setItems(autoTile([...ids, id])); };
  const removeCam = (id: number) => setItems(autoTile(ids.filter((x) => x !== id)));
  const applySavedLayout = (l: VideoLayout) => {
    const its = (l.config?.items ?? []).filter((i) => camById.has(i.cameraId));
    if (!its.length) return alert("เลย์เอาต์นี้ไม่มีกล้องที่บันทึกไว้");
    // scale the layout page's grid (rows of 44 px, open-ended) to fill our 12-row stage
    const maxY = Math.max(...its.map((i) => i.y + i.h));
    setItems(its.map((i) => ({ ...i, y: Math.round((i.y * ROWS) / maxY), h: Math.max(1, Math.round((i.h * ROWS) / maxY)) })));
  };
  const [selectedId, setSelectedId] = useState<number | null>(linkCam);
  const selected = selectedId !== null && ids.includes(selectedId) ? selectedId : ids[0] ?? null;

  // ── segments of every camera on the stage ──
  const segQs = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["recordings", "segments", id, day],
      queryFn: () => api<Seg[]>(`/api/recordings/${id}/segments?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`),
      refetchInterval: isToday ? 30000 : (false as const),
    })),
  });
  const segsBy = useMemo(() => new Map(ids.map((id, i) => [id, segQs[i]?.data ?? []])), [ids.join(","), segQs.map((q) => q.dataUpdatedAt).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const allSpans = useMemo(() => {
    const all = [...segsBy.values()].flat().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return toSpans(all);
  }, [segsBy]);

  // ── shared clock ──
  const [t, setT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const clock = useRef({ base: 0, at: 0 });
  const tNow = useRef<number | null>(null);
  tNow.current = t;
  const report = useRef<TimeReport | null>(null);

  const seek = useCallback((x: number) => {
    const c = Math.min(Math.max(x, from), to - 1000);
    clock.current = { base: c, at: performance.now() };
    report.current = null;
    setT(c);
  }, [from, to]);
  const togglePlay = () => {
    if (t === null) { const s = allSpans[0]; if (!s) return; seek(s.s); setPlaying(true); return; }
    clock.current = { base: t, at: performance.now() };
    setPlaying((p) => !p);
  };
  const changeRate = (r: number) => { if (t !== null) clock.current = { base: t, at: performance.now() }; setRate(r); };

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const now = performance.now();
      // follow the selected tile's real video time when it is playing (no running ahead of buffering)
      const r = report.current;
      let cur = r && now - r.at < 700 && (r.camId === selected || !segAt(segsBy.get(selected ?? -1) ?? [], tNow.current ?? 0))
        ? r.t + (now - r.at) * rate
        : clock.current.base + (now - clock.current.at) * rate;
      // nobody has footage here: jump to the next recorded span instead of crawling through the gap
      if (![...segsBy.values()].some((s) => segAt(s, cur))) {
        const nextSpan = allSpans.find((s) => s.s > cur);
        if (!nextSpan) { setPlaying(false); return; }
        cur = nextSpan.s;
      }
      if (cur >= to - 1000 || (isToday && cur > Date.now())) { setPlaying(false); return; }
      clock.current = { base: cur, at: now };
      setT(cur);
    }, 250);
    return () => clearInterval(id);
  }, [playing, rate, selected, segsBy, allSpans, to, isToday]);
  const onReport = useCallback((r: TimeReport) => { report.current = r; }, []);

  const videos = useRef(new Map<number, HTMLVideoElement | null>());
  const register = useCallback((id: number, v: HTMLVideoElement | null) => { videos.current.set(id, v); }, []);

  // reset when the day changes; apply a deep-link time once footage is known
  useEffect(() => { setPlaying(false); setT(null); setZoomHour(null); }, [day]);
  const [zoomHour, setZoomHour] = useState<number | null>(null);
  const pendingSeek = useRef(linkT);
  useEffect(() => {
    if (pendingSeek.current === null || !allSpans.length) return;
    const x = pendingSeek.current;
    pendingSeek.current = null;
    setZoomHour(Math.floor((x - from) / HOUR) * HOUR + from);
    seek(x);
    setPlaying(true);
    setParams({}, { replace: true });
  }, [allSpans.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const zFrom = zoomHour ?? (t !== null ? Math.floor((t - from) / HOUR) * HOUR + from : allSpans.at(-1) ? Math.floor((allSpans.at(-1)!.e - 1 - from) / HOUR) * HOUR + from : from);
  const seekAndZoom = (x: number) => { setZoomHour(Math.floor((x - from) / HOUR) * HOUR + from); seek(x); };
  const step = (ms: number) => { if (t !== null) { seek(t + ms); setZoomHour(null); } };

  // keyboard: space play/pause, ←/→ ±10 s (shift ±1 min)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,select,textarea")) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      if (e.code === "ArrowLeft") step(e.shiftKey ? -60_000 : -10_000);
      if (e.code === "ArrowRight") step(e.shiftKey ? 60_000 : 10_000);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selCam = selected !== null ? camById.get(selected) : undefined;
  const snapshot = () => {
    const v = selected !== null ? videos.current.get(selected) : null;
    if (!v || !v.videoWidth || t === null) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `${selCam?.deviceNo ?? "cam"}_${toLocalInput(new Date(t)).replace(/[-:T]/g, "")}${String(new Date(t).getSeconds()).padStart(2, "0")}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  };

  // ── export (selected camera) ──
  const [exportOpen, setExportOpen] = useState(false);
  const [exFrom, setExFrom] = useState("");
  const [exTo, setExTo] = useState("");
  const [exErr, setExErr] = useState<string | null>(null);
  const exporting = useMutation({
    mutationFn: () => download(
      `/api/recordings/${selected}/export?from=${new Date(exFrom).toISOString()}&to=${new Date(exTo).toISOString()}`,
      `${selCam?.deviceNo}_${exFrom.replace(/[-:T]/g, "")}.mp4`,
    ),
    onSuccess: () => setExErr(null),
    onError: (e) => setExErr((e as Error).message),
  });
  const openExport = () => {
    const base = t ?? Date.now();
    setExFrom(toLocalInput(new Date(base - 60_000)));
    setExTo(toLocalInput(new Date(base + 4 * 60_000)));
    setExErr(null);
    setExportOpen(true);
  };

  // ── stage size → row height so the grid fills the screen ──
  const stage = useRef<HTMLDivElement>(null);
  const [stageH, setStageH] = useState(480);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const MARGIN = 6;
  const rowH = Math.max(20, (stageH - MARGIN * (ROWS + 1)) / ROWS);
  const rgl: RglLayout[] = items.map((i) => ({ i: String(i.cameraId), x: i.x, y: i.y, w: i.w, h: i.h, minW: 2, minH: 2 }));
  const onLayoutChange = (next: RglLayout[]) => {
    if (!editing) return;
    setItems(next.map((n) => ({ cameraId: Number(n.i), x: n.x, y: n.y, w: n.w, h: n.h })));
  };
  const hevc = ids.some((id) => (segsBy.get(id) ?? [])[0]?.videoCodec === "hevc");

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="ดูย้อนหลัง / Playback" subtitle="ภาพที่ระบบบันทึกเองจาก go2rtc (ไม่ผ่าน NVR) · ดูหลายกล้องพร้อมกันในเวลาเดียวกัน" />
      <StatusPanel status={status.data} isAdmin={isAdmin} open={panelOpen} onToggle={togglePanel} />

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-5 pb-2 text-xs">
        <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="!w-40" />
        <Select className="!w-64" value="" onChange={(e) => { if (e.target.value) addCam(Number(e.target.value)); }}>
          <option value="">+ เพิ่มกล้อง (เฉพาะที่มีบันทึก)…</option>
          {recCams.filter((c) => !ids.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.deviceNo} {c.name}</option>)}
        </Select>
        <Select className="!w-56" value="" onChange={(e) => { const l = savedLayouts.data?.find((x) => x.id === Number(e.target.value)); if (l) applySavedLayout(l); }}>
          <option value="">ใช้เลย์เอาต์ที่บันทึกไว้…</option>
          {savedLayouts.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <Button variant={editing ? "primary" : "ghost"} onClick={() => setEditing((v) => !v)}><Pencil size={13} /> {editing ? "จัดตำแหน่งเสร็จ" : "จัดตำแหน่ง"}</Button>
        <Button variant="ghost" onClick={() => setItems(autoTile(ids))} title="เรียงให้เท่ากัน"><LayoutGrid size={13} /></Button>
        <span className="ml-auto text-zinc-500">{ids.length} กล้อง{hevc && " · H.265 ต้องใช้ Chrome/Edge/Safari ที่ถอดรหัสด้วยฮาร์ดแวร์"}</span>
      </div>

      {/* timelines */}
      <div className="space-y-1 px-5">
        <Timeline from={from} to={to} spans={allSpans} cursor={t} onSeek={seekAndZoom} tickMs={HOUR} label={(x) => String(new Date(x).getHours()).padStart(2, "0")} />
        <Timeline from={zFrom} to={zFrom + HOUR} spans={allSpans} cursor={t} onSeek={(x) => { seek(x); }} tickMs={5 * 60_000} label={(x) => fmtTime(x, false)} />
      </div>

      {/* transport bar */}
      <div className="flex flex-wrap items-center gap-1.5 px-5 py-2 text-xs">
        <Button variant="gold" onClick={togglePlay} disabled={!allSpans.length}>{playing ? <Pause size={14} /> : <Play size={14} />}</Button>
        <Button variant="ghost" disabled={t === null} onClick={() => step(-60_000)} title="ย้อน 1 นาที (Shift+←)"><Rewind size={13} /> 1 นาที</Button>
        <Button variant="ghost" disabled={t === null} onClick={() => step(-10_000)} title="ย้อน 10 วินาที (←)">−10s</Button>
        <Button variant="ghost" disabled={t === null} onClick={() => step(10_000)} title="ไปข้างหน้า 10 วินาที (→)">+10s</Button>
        <Button variant="ghost" disabled={t === null} onClick={() => step(60_000)} title="ไปข้างหน้า 1 นาที (Shift+→)">1 นาที <FastForward size={13} /></Button>
        <div className="mx-1 flex">
          {[1, 2, 4, 8].map((r) => (
            <button key={r} onClick={() => changeRate(r)} className={clsx("rounded px-2 py-1", rate === r ? "bg-gold-600 text-onaccent" : "text-zinc-400 hover:bg-ink-800")}>{r}x</button>
          ))}
        </div>
        <span className="font-mono text-base text-cream">{t !== null ? new Date(t).toLocaleString("th-TH", { hour12: false }) : "—"}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-zinc-500">กล้องที่เลือก: <span className="text-cream">{selCam?.deviceNo ?? "-"}</span></span>
          <Button variant="ghost" disabled={t === null || selected === null} onClick={snapshot} title="บันทึกภาพนิ่งของกล้องที่เลือก"><CameraIcon size={14} /></Button>
          <Button variant="ghost" disabled={selected === null} onClick={openExport}><Download size={13} /> ส่งออกคลิป</Button>
        </div>
      </div>

      {/* stage */}
      <div ref={stage} className="min-h-0 flex-1 overflow-hidden px-3 pb-3">
        {items.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-zinc-600">
            <div className="text-center"><Plus className="mx-auto mb-1" size={18} />เพิ่มกล้องจากรายการด้านบน</div>
          </div>
        ) : (
          <Grid
            layout={rgl}
            cols={COLS}
            rowHeight={rowH}
            maxRows={ROWS}
            margin={[MARGIN, MARGIN]}
            isDraggable={editing}
            isResizable={editing}
            draggableCancel=".drag-cancel"
            onLayoutChange={onLayoutChange}
            compactType={null}
            preventCollision
          >
            {items.map((it) => {
              const cam = camById.get(it.cameraId);
              if (!cam) return <div key={String(it.cameraId)} />;
              return (
                <div key={String(it.cameraId)}>
                  <RecTile
                    cam={cam} segs={segsBy.get(cam.id) ?? []} t={t} playing={playing} rate={rate}
                    selected={selected === cam.id} editing={editing}
                    onSelect={() => setSelectedId(cam.id)} onRemove={() => removeCam(cam.id)}
                    onReport={onReport} register={register}
                  />
                </div>
              );
            })}
          </Grid>
        )}
      </div>

      {exportOpen && (
        <Modal title={`ส่งออกคลิป · ${selCam?.deviceNo ?? ""}`} onClose={() => setExportOpen(false)}>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-zinc-500">ส่งออกจากกล้องที่เลือก (กรอบสีทอง) ได้ครั้งละไม่เกิน 2 ชั่วโมง</p>
            <Field label="ตั้งแต่"><Input type="datetime-local" step={1} value={exFrom} onChange={(e) => setExFrom(e.target.value)} /></Field>
            <Field label="ถึง"><Input type="datetime-local" step={1} value={exTo} onChange={(e) => setExTo(e.target.value)} /></Field>
            {exErr && <div className="text-xs text-red-400">{exErr}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setExportOpen(false)}>ปิด</Button>
              <Button variant="gold" disabled={!exFrom || !exTo || exporting.isPending} onClick={() => exporting.mutate()}>
                <Download size={13} className="inline" /> {exporting.isPending ? "กำลังสร้าง…" : "ดาวน์โหลด"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
