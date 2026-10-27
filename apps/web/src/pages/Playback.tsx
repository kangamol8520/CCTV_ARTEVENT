import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Camera } from "../types";
import { Button, Field, Input, PageHeader, Select, toLocalInput } from "../components/ui";
import { LivePlayer } from "../components/LivePlayer";

interface Segment { start: string; end: string; type: string }
interface SegmentsResp { nvr: { name: string }; channel: number; segments: Segment[] }

export function Playback() {
  const cameras = useQuery({ queryKey: ["cameras", "all"], queryFn: () => api<Camera[]>("/api/cameras") });
  const [cameraId, setCameraId] = useState<number | "">("");
  const [from, setFrom] = useState(toLocalInput(new Date(Date.now() - 3600000)));
  const [to, setTo] = useState(toLocalInput(new Date()));
  const [segments, setSegments] = useState<SegmentsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [play, setPlay] = useState<{ stream: string; go2rtcUrl: string } | null>(null);

  const search = useMutation({
    mutationFn: () => api<SegmentsResp>(`/api/playback/${cameraId}/segments?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`),
    onSuccess: (r) => { setSegments(r); setErr(null); },
    onError: (e) => { setErr((e as Error).message); setSegments(null); },
  });
  const open = useMutation({
    mutationFn: (range: { from: string; to: string }) => api<{ stream: string; go2rtcUrl: string }>(`/api/playback/${cameraId}/stream`, { method: "POST", json: range }),
    onSuccess: (r) => { setPlay(r); setErr(null); },
    onError: (e) => setErr((e as Error).message),
  });
  useEffect(() => () => { if (play) api(`/api/playback/stream/${play.stream}`, { method: "DELETE" }).catch(() => {}); }, [play]);

  const cam = cameras.data?.find((c) => c.id === cameraId);
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="ดูย้อนหลัง (ข้าม NVR อัตโนมัติ)" />
      <div className="flex flex-wrap items-end gap-2 px-5 py-3">
        <Field label="กล้อง"><Select className="w-72" value={cameraId} onChange={(e) => { setCameraId(e.target.value ? Number(e.target.value) : ""); setSegments(null); setPlay(null); }}><option value="">เลือกกล้อง</option>{cameras.data?.filter((c) => c.nvrId).map((c) => <option key={c.id} value={c.id}>{c.deviceNo} {c.name} — {c.nvr?.name}{c.nvrChannel ? ` ch${c.nvrChannel}` : " (ยังไม่ระบุช่อง)"}</option>)}</Select></Field>
        <Field label="ตั้งแต่"><Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="ถึง"><Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Button disabled={!cameraId || search.isPending} onClick={() => search.mutate()}>ค้นหาช่วงที่บันทึก</Button>
        <Button variant="ghost" disabled={!cameraId || open.isPending} onClick={() => open.mutate({ from: new Date(from).toISOString(), to: new Date(to).toISOString() })}>เล่นช่วงนี้</Button>
        {cam && <span className="text-xs text-zinc-500">บันทึกที่ {cam.nvr?.name} ช่อง {cam.nvrChannel ?? "?"}</span>}
      </div>
      {err && <div className="px-5 text-sm text-red-400">{err}</div>}
      <div className="flex min-h-0 flex-1 gap-3 px-5 pb-5">
        <div className="w-80 shrink-0 overflow-auto rounded border border-zinc-800">
          {segments?.segments.length === 0 && <div className="p-3 text-xs text-zinc-500">ไม่พบการบันทึกในช่วงนี้</div>}
          {segments?.segments.map((s, i) => (
            <button key={i} onClick={() => open.mutate({ from: s.start, to: s.end })} className="flex w-full items-center justify-between border-b border-zinc-800/60 px-3 py-1.5 text-left text-xs hover:bg-zinc-800">
              <span>{new Date(s.start).toLocaleTimeString("th-TH")} – {new Date(s.end).toLocaleTimeString("th-TH")}</span>
              <span className="text-zinc-500">{s.type}</span>
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 rounded bg-black">{play ? <LivePlayer go2rtcUrl={play.go2rtcUrl} stream={play.stream} mode="mse" /> : <div className="flex h-full items-center justify-center text-sm text-zinc-600">เลือกกล้องและช่วงเวลา</div>}</div>
      </div>
    </div>
  );
}
