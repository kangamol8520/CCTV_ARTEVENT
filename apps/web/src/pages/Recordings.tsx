/**
 * Central recordings (Phase 2): footage recorded by our own recorder (not the NVR).
 * The day is a list of ~1-minute MP4 files; the player chains them so playback looks continuous,
 * and the two timelines (whole day + 1-hour zoom) show where footage exists and seek on click.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera as CameraIcon, Download, Pause, Play, Square, Circle } from "lucide-react";
import clsx from "clsx";
import { useSearchParams } from "react-router-dom";
import { api, API_URL, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Camera } from "../types";
import { Button, Card, Field, Input, PageHeader, Select, StatusDot, fmtDate, toLocalInput } from "../components/ui";

interface RecCamera {
  id: number; deviceNo: string; name: string; status: string; recordEnabled: boolean; recordStream: string;
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

function StatusPanel({ status, isAdmin }: { status: RecStatus | undefined; isAdmin: boolean }) {
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
    <Card className="mx-5 mb-3 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="flex items-center gap-1.5">
          <span className={clsx("h-2 w-2 rounded-full", rec?.alive ? "bg-emerald-400" : "bg-red-500")} />
          ตัวบันทึก {rec?.alive ? "ทำงาน" : "ไม่ทำงาน"}
        </span>
        <span className="text-zinc-400">ไฟล์ละ {status?.config.segmentSeconds}s · เก็บ {status?.config.retentionDays} วัน · กันพื้นที่ ≥ {status?.config.minFreeGb} GB</span>
        {status?.disk && <span className="text-zinc-400">ใช้ไป {fmtBytes(used)} · ดิสก์ว่าง {fmtBytes(status.disk.freeBytes)} / {fmtBytes(status.disk.totalBytes)}</span>}
      </div>
      <table className="w-full">
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
    </Card>
  );
}

export function Recordings() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const status = useQuery({ queryKey: ["recordings", "status"], queryFn: () => api<RecStatus>("/api/recordings/status"), refetchInterval: 15000 });
  const recCams = useMemo(() => status.data?.cameras.filter((c) => c.files > 0 || c.recordEnabled) ?? [], [status.data]);

  // Deep link from other pages (e.g. บันทึกเข้า-ออก): /recordings?cam=<id>&t=<epoch ms>
  const [params, setParams] = useSearchParams();
  const linkT = params.get("t") ? Number(params.get("t")) : null;
  const [cameraId, setCameraId] = useState<number | "">(params.get("cam") ? Number(params.get("cam")) : "");
  const [day, setDay] = useState(localDay(linkT ? new Date(linkT) : new Date()));
  useEffect(() => { if (cameraId === "" && recCams[0]) setCameraId(recCams[0].id); }, [recCams, cameraId]);
  const cam = recCams.find((c) => c.id === cameraId);

  const from = dayStart(day);
  const to = from + 24 * HOUR;
  const isToday = day === localDay(new Date());
  const segsQ = useQuery({
    queryKey: ["recordings", "segments", cameraId, day],
    queryFn: () => api<Seg[]>(`/api/recordings/${cameraId}/segments?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`),
    enabled: cameraId !== "",
    refetchInterval: isToday ? 30000 : false,
  });
  const segs = segsQ.data ?? [];
  const spans = useMemo(() => toSpans(segs), [segs]);

  // ── player ──
  const video = useRef<HTMLVideoElement>(null);
  const [cur, setCur] = useState<{ id: number; offset: number } | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const curSeg = cur ? segs.find((s) => s.id === cur.id) ?? null : null;

  useEffect(() => { setCur(null); setCursor(null); }, [cameraId, day]);

  const seek = useCallback((t: number) => {
    const list = segsQ.data ?? [];
    const hit = list.find((s) => new Date(s.startedAt).getTime() <= t && t < new Date(s.endedAt).getTime())
      ?? list.find((s) => new Date(s.startedAt).getTime() > t);
    if (!hit) return;
    const start = new Date(hit.startedAt).getTime();
    const offset = Math.max(0, (t - start) / 1000);
    setCursor(Math.max(t, start));
    if (cur?.id === hit.id && video.current) {
      video.current.currentTime = offset;
      video.current.play().catch(() => {});
    } else {
      setCur({ id: hit.id, offset });
    }
  }, [segsQ.data, cur]);

  const [zoomHour, setZoomHour] = useState<number | null>(null);
  const pendingSeek = useRef(linkT);
  useEffect(() => {
    if (pendingSeek.current === null || !segsQ.data?.length) return;
    const t = pendingSeek.current;
    pendingSeek.current = null;
    setZoomHour(Math.floor((t - from) / HOUR) * HOUR + from);
    seek(t);
    setParams({}, { replace: true });
  }, [segsQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = () => {
    if (!curSeg) return;
    const i = segs.findIndex((s) => s.id === curSeg.id);
    const n = segs[i + 1];
    if (n) setCur({ id: n.id, offset: 0 });
    else setPlaying(false);
  };

  const zFrom = zoomHour ?? (cursor !== null ? Math.floor((cursor - from) / HOUR) * HOUR + from : spans.at(-1) ? Math.floor((spans.at(-1)!.e - 1 - from) / HOUR) * HOUR + from : from);
  const seekAndZoom = (t: number) => { setZoomHour(Math.floor((t - from) / HOUR) * HOUR + from); seek(t); };

  const snapshot = () => {
    const v = video.current;
    if (!v || !v.videoWidth || cursor === null) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `${cam?.deviceNo ?? "cam"}_${toLocalInput(new Date(cursor)).replace(/[-:T]/g, "")}${String(new Date(cursor).getSeconds()).padStart(2, "0")}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  };

  const [exFrom, setExFrom] = useState("");
  const [exTo, setExTo] = useState("");
  const [exErr, setExErr] = useState<string | null>(null);
  const exporting = useMutation({
    mutationFn: () => download(
      `/api/recordings/${cameraId}/export?from=${new Date(exFrom).toISOString()}&to=${new Date(exTo).toISOString()}`,
      `${cam?.deviceNo}_${exFrom.replace(/[-:T]/g, "")}.mp4`,
    ),
    onSuccess: () => setExErr(null),
    onError: (e) => setExErr((e as Error).message),
  });
  const fillExport = () => {
    const base = cursor ?? Date.now();
    setExFrom(toLocalInput(new Date(base - 60_000)));
    setExTo(toLocalInput(new Date(base + 4 * 60_000)));
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="บันทึกกลาง (ทดสอบ)" subtitle="ภาพที่ระบบบันทึกเองจาก go2rtc — ไม่ผ่าน NVR" />
      <StatusPanel status={status.data} isAdmin={isAdmin} />

      <div className="flex flex-wrap items-end gap-2 px-5 pb-2">
        <Field label="กล้อง">
          <Select className="w-72" value={cameraId} onChange={(e) => setCameraId(e.target.value ? Number(e.target.value) : "")}>
            {recCams.length === 0 && <option value="">ยังไม่มีกล้องที่บันทึก</option>}
            {recCams.map((c) => <option key={c.id} value={c.id}>{c.deviceNo} {c.name}</option>)}
          </Select>
        </Field>
        <Field label="วันที่"><Input type="date" value={day} onChange={(e) => { setDay(e.target.value); setZoomHour(null); }} /></Field>
        <div className="ml-auto flex items-center gap-1 text-xs text-zinc-400">
          {segs.length > 0 && <span>{segs.length} ไฟล์ · {fmtBytes(segs.reduce((a, s) => a + s.sizeBytes, 0))} · {segs[0]!.videoCodec?.toUpperCase()} {segs[0]!.width}×{segs[0]!.height}</span>}
        </div>
      </div>

      <div className="space-y-1 px-5">
        <Timeline from={from} to={to} spans={spans} cursor={cursor} onSeek={seekAndZoom} tickMs={HOUR} label={(t) => String(new Date(t).getHours()).padStart(2, "0")} />
        <Timeline from={zFrom} to={zFrom + HOUR} spans={spans} cursor={cursor} onSeek={seek} tickMs={5 * 60_000} label={(t) => fmtTime(t, false)} />
      </div>

      <div className="flex min-h-0 flex-1 gap-3 px-5 py-3">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded bg-black">
          {curSeg ? (
            <video
              ref={video}
              key={curSeg.id}
              src={API_URL + curSeg.url}
              crossOrigin="anonymous"
              className="h-full w-full object-contain"
              controls
              autoPlay
              muted
              onLoadedMetadata={(e) => { e.currentTarget.currentTime = cur?.offset ?? 0; e.currentTarget.playbackRate = rate; }}
              onTimeUpdate={(e) => setCursor(new Date(curSeg.startedAt).getTime() + e.currentTarget.currentTime * 1000)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={next}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-zinc-600">
              {segsQ.isLoading ? "กำลังโหลด…" : segs.length ? "คลิกบนแถบเวลาเพื่อเล่น" : "ไม่มีภาพในวันนี้"}
            </div>
          )}
          {cursor !== null && (
            <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 font-mono text-sm text-cream">
              {new Date(cursor).toLocaleString("th-TH", { hour12: false })}
            </div>
          )}
        </div>

        <div className="w-64 shrink-0 space-y-3 text-xs">
          <Card className="space-y-2 p-3">
            <div className="flex items-center gap-1">
              <Button variant="ghost" disabled={!curSeg} onClick={() => (playing ? video.current?.pause() : video.current?.play())}>{playing ? <Pause size={14} /> : <Play size={14} />}</Button>
              {[1, 2, 4, 8].map((r) => (
                <button key={r} onClick={() => { setRate(r); if (video.current) video.current.playbackRate = r; }}
                  className={clsx("rounded px-2 py-1", rate === r ? "bg-gold-600 text-onaccent" : "text-zinc-400 hover:bg-ink-800")}>{r}x</button>
              ))}
            </div>
            <div className="flex gap-1">
              <Button variant="ghost" disabled={cursor === null} onClick={() => cursor !== null && seek(cursor - 10_000)}>−10s</Button>
              <Button variant="ghost" disabled={cursor === null} onClick={() => cursor !== null && seek(cursor + 10_000)}>+10s</Button>
              <Button variant="ghost" disabled={!curSeg} onClick={snapshot} title="บันทึกภาพนิ่ง"><CameraIcon size={14} /></Button>
            </div>
          </Card>
          <Card className="space-y-2 p-3">
            <div className="font-medium text-cream">ส่งออกคลิป (≤ 2 ชม.)</div>
            <Field label="ตั้งแต่"><Input type="datetime-local" step={1} value={exFrom} onChange={(e) => setExFrom(e.target.value)} /></Field>
            <Field label="ถึง"><Input type="datetime-local" step={1} value={exTo} onChange={(e) => setExTo(e.target.value)} /></Field>
            <div className="flex gap-1">
              <Button variant="ghost" onClick={fillExport}>ใช้เวลาปัจจุบัน</Button>
              <Button disabled={!cameraId || !exFrom || !exTo || exporting.isPending} onClick={() => exporting.mutate()}>
                <Download size={13} className="inline" /> {exporting.isPending ? "กำลังสร้าง…" : "ดาวน์โหลด"}
              </Button>
            </div>
            {exErr && <div className="text-red-400">{exErr}</div>}
          </Card>
          {curSeg?.videoCodec === "hevc" && (
            <div className="rounded border border-amber-700/40 bg-amber-900/10 p-2 text-[11px] text-amber-300">
              กล้องนี้เป็น H.265 — เล่นได้ใน Chrome/Edge/Safari ที่มีการถอดรหัสด้วยฮาร์ดแวร์ ถ้าภาพดำให้ลองเบราว์เซอร์อื่น
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
