/**
 * Pop-up player for a moment of central-recording footage (so pages like เทียบเวลาเข้างาน /
 * บันทึกเข้า-ออก can show the clip without leaving the page). Plays the 1-minute files around `t`
 * back to back, starting a few seconds before `t`; fisheye cameras open in free-look mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Orbit, Pause, Play, X } from "lucide-react";
import clsx from "clsx";
import { api, API_URL } from "../lib/api";
import { Button } from "./ui";
import { FisheyeView, parseFisheye } from "./FisheyeView";

interface Seg { id: number; startedAt: string; endedAt: string; url: string; videoCodec: string | null }
interface RecStatus { cameras: { id: number; deviceNo: string; name: string; fisheye: string | null }[] }

const LEAD_MS = 5_000; // start this much before the moment
const fmt = (t: number) => new Date(t).toLocaleTimeString("th-TH", { hour12: false });

export function ClipDialog({ cameraId, at, title, onClose }: { cameraId: number; at: number; title?: string; onClose: () => void }) {
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ["recordings", "status"], queryFn: () => api<RecStatus>("/api/recordings/status"), staleTime: 60_000 });
  const cam = status.data?.cameras.find((c) => c.id === cameraId);
  const cal = parseFisheye(cam?.fisheye);
  const [dewarp, setDewarp] = useState(true);

  const from = at - 10 * 60_000, to = at + 10 * 60_000;
  const segsQ = useQuery({
    queryKey: ["recordings", "clip", cameraId, Math.floor(at / 60_000)],
    queryFn: () => api<Seg[]>(`/api/recordings/${cameraId}/segments?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`),
  });
  const segs = useMemo(() => segsQ.data ?? [], [segsQ.data]);

  const video = useRef<HTMLVideoElement | null>(null);
  const getVideo = useCallback(() => video.current, []);
  const [cur, setCur] = useState<{ i: number; offset: number } | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [playing, setPlaying] = useState(true);

  const seek = useCallback((t: number) => {
    const i = segs.findIndex((g) => new Date(g.startedAt).getTime() <= t && t < new Date(g.endedAt).getTime());
    const j = i >= 0 ? i : segs.findIndex((g) => new Date(g.startedAt).getTime() > t);
    if (j < 0) return;
    const start = new Date(segs[j]!.startedAt).getTime();
    const offset = Math.max(0, (t - start) / 1000);
    if (cur?.i === j && video.current) { video.current.currentTime = offset; setNow(start + offset * 1000); }
    else setCur({ i: j, offset });
  }, [segs, cur]);

  useEffect(() => { if (segs.length && !cur) seek(at - LEAD_MS); }, [segs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.code === "Space") { e.preventDefault(); toggle(); }
      if (e.code === "ArrowLeft" && now !== null) seek(now - 10_000);
      if (e.code === "ArrowRight" && now !== null) seek(now + 10_000);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const seg = cur ? segs[cur.i] : undefined;
  const segStart = seg ? new Date(seg.startedAt).getTime() : 0;
  const toggle = () => { const v = video.current; if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause(); };

  // small scrubber: ±10 min around the moment
  const bar = useRef<HTMLDivElement>(null);
  const pct = (t: number) => `${((t - from) / (to - from)) * 100}%`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-ink-800 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-sm font-semibold text-cream">{title ?? cam?.deviceNo ?? `กล้อง ${cameraId}`}</div>
            <div className="text-xs text-zinc-500">{cam?.deviceNo} {cam?.name} · เหตุการณ์ {fmt(at)}</div>
          </div>
          <Button variant="ghost" onClick={() => { onClose(); navigate(`/recordings?cam=${cameraId}&t=${(now ?? at) - 3000}`); }} title="เปิดในหน้าดูย้อนหลัง (หลายกล้อง)"><ExternalLink size={14} /> หน้าดูย้อนหลัง</Button>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-ink-800 hover:text-cream" title="ปิด (Esc)"><X size={18} /></button>
        </div>

        <div className="relative aspect-video w-full bg-black">
          {seg ? (
            <video
              key={seg.id}
              ref={video}
              src={API_URL + seg.url}
              crossOrigin="anonymous"
              muted
              playsInline
              autoPlay={playing}
              className={clsx("h-full w-full object-contain", cal && dewarp && "invisible")}
              onLoadedMetadata={(e) => { e.currentTarget.currentTime = cur?.offset ?? 0; if (playing) e.currentTarget.play().catch(() => {}); }}
              onTimeUpdate={(e) => setNow(segStart + e.currentTarget.currentTime * 1000)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => { if (cur && cur.i + 1 < segs.length) setCur({ i: cur.i + 1, offset: 0 }); }}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-zinc-500">
              {segsQ.isLoading ? "กำลังโหลด…" : "ไม่มีภาพบันทึกของกล้องนี้ในช่วงเวลานี้"}
            </div>
          )}
          {seg && cal && dewarp && <div className="absolute inset-0"><FisheyeView getVideo={getVideo} cal={cal} /></div>}
          {seg && cal && (
            <button onClick={() => setDewarp((d) => !d)} className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded bg-black/70 px-2 py-1 text-xs text-zinc-300 hover:text-gold-300">
              <Orbit size={14} /> {dewarp ? "ภาพเต็มวง" : "หมุนดูภาพ"}
            </button>
          )}
          {now !== null && <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 font-mono text-sm text-cream">{fmt(now)}</div>}
        </div>

        <div className="space-y-2 px-4 py-3 text-xs">
          <div
            ref={bar}
            className="relative h-6 cursor-pointer overflow-hidden rounded border border-ink-800 bg-ink-950"
            onClick={(e) => { const r = bar.current!.getBoundingClientRect(); seek(from + ((e.clientX - r.left) / r.width) * (to - from)); }}
          >
            {segs.map((g) => (
              <div key={g.id} className="absolute inset-y-1 bg-gold-500/60" style={{ left: pct(Math.max(from, new Date(g.startedAt).getTime())), width: `calc(${pct(Math.min(to, new Date(g.endedAt).getTime()))} - ${pct(Math.max(from, new Date(g.startedAt).getTime()))})` }} />
            ))}
            <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: pct(at) }} title={`เหตุการณ์ ${fmt(at)}`} />
            {now !== null && <div className="absolute inset-y-0 w-0.5 bg-red-500" style={{ left: pct(now) }} />}
          </div>
          <div className="flex items-center justify-between text-[10px] text-zinc-500"><span>{fmt(from)}</span><span className="text-emerald-400">▲ เวลาเหตุการณ์</span><span>{fmt(to)}</span></div>
          <div className="flex items-center gap-1.5">
            <Button variant="gold" disabled={!seg} onClick={toggle}>{playing ? <Pause size={14} /> : <Play size={14} />}</Button>
            <Button variant="ghost" disabled={now === null} onClick={() => now !== null && seek(now - 10_000)}>−10s</Button>
            <Button variant="ghost" disabled={now === null} onClick={() => now !== null && seek(now + 10_000)}>+10s</Button>
            <Button variant="ghost" disabled={!segs.length} onClick={() => seek(at - LEAD_MS)}>กลับไปเวลาเหตุการณ์</Button>
            <span className="ml-auto text-zinc-500">Space เล่น/หยุด · ← → ±10 วินาที · Esc ปิด</span>
          </div>
        </div>
      </div>
    </div>
  );
}
