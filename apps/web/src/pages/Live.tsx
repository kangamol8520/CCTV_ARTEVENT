import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, Video, X } from "lucide-react";
import clsx from "clsx";
import { api } from "../lib/api";
import type { Camera, CameraGroup, FloorNode } from "../types";
import { LivePlayer } from "../components/LivePlayer";
import { LazyVisible } from "../components/LazyVisible";
import { StatusDot } from "../components/ui";

type Selection = { kind: "floor"; id: number } | { kind: "room"; id: number } | { kind: "group"; id: number } | { kind: "all" };

const COLS = [2, 3, 4, 5, 6];

export function Live() {
  const tree = useQuery({ queryKey: ["locations-tree"], queryFn: () => api<FloorNode[]>("/api/locations/tree") });
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api<CameraGroup[]>("/api/groups") });
  const cameras = useQuery({ queryKey: ["cameras", "enabled"], queryFn: () => api<Camera[]>("/api/cameras?enabled=true"), refetchInterval: 60000 });
  // Start on nothing, then land on the first floor — never auto-open all cameras (network cost).
  const [sel, setSel] = useState<Selection | null>(null);
  const [cols, setCols] = useState(4);
  const [focus, setFocus] = useState<Camera | null>(null);
  const [onlyOnline, setOnlyOnline] = useState(false);

  useEffect(() => {
    if (!sel && tree.data && tree.data.length) {
      const f = tree.data.find((f) => f.cameraCount > 0) ?? tree.data[0]!;
      setSel({ kind: "floor", id: f.id });
    }
  }, [sel, tree.data]);

  const visible = useMemo(() => {
    const all = cameras.data ?? [];
    if (!sel) return [];
    let list: Camera[];
    if (sel.kind === "floor") list = all.filter((c) => c.floorId === sel.id);
    else if (sel.kind === "room") list = all.filter((c) => c.roomId === sel.id);
    else if (sel.kind === "group") {
      const g = groups.data?.find((g) => g.id === sel.id);
      const ids = g?.members.map((m) => m.id) ?? [];
      list = ids.map((id) => all.find((c) => c.id === id)).filter((c): c is Camera => !!c);
    } else list = all;
    return onlyOnline ? list.filter((c) => c.status === "ONLINE") : list;
  }, [cameras.data, groups.data, sel, onlyOnline]);

  const selGroup = sel?.kind === "group" ? groups.data?.find((g) => g.id === sel.id) : undefined;
  const gridCols = selGroup?.gridColumns ?? cols;
  const title = !sel ? "" : sel.kind === "all" ? "กล้องทั้งหมด" : sel.kind === "group" ? selGroup?.name : sel.kind === "floor" ? tree.data?.find((f) => f.id === sel.id)?.name : tree.data?.flatMap((f) => f.rooms).find((r) => r.id === sel.id)?.name;

  const item = (active: boolean, label: string, count: number | undefined, onClick: () => void, indent = false) => (
    <button onClick={onClick} className={clsx("flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm", indent && "pl-7", active ? "bg-ink-800 text-cream ring-1 ring-gold-700/50" : "text-zinc-400 hover:bg-ink-850")}>
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="text-xs text-zinc-600">{count}</span>}
    </button>
  );

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 overflow-auto border-r border-ink-800 bg-ink-900/60 p-2">
        <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">กลุ่มที่กำหนดเอง</div>
        {groups.data?.map((g) => item(sel?.kind === "group" && sel.id === g.id, g.name, g.members.length, () => setSel({ kind: "group", id: g.id })))}
        {groups.data?.length === 0 && <div className="px-2 text-xs text-zinc-600">ยังไม่มีกลุ่ม</div>}
        <div className="mt-3 px-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">ตามชั้น / ห้อง</div>
        {tree.data?.map((f) => (
          <div key={f.id}>
            {item(sel?.kind === "floor" && sel.id === f.id, f.name, f.cameraCount, () => setSel({ kind: "floor", id: f.id }))}
            {f.rooms.filter((r) => r.cameraCount > 0).map((r) => item(sel?.kind === "room" && sel.id === r.id, r.name, r.cameraCount, () => setSel({ kind: "room", id: r.id }), true))}
          </div>
        ))}
        <div className="mt-3 border-t border-ink-800 pt-2">
          {item(sel?.kind === "all", "กล้องทั้งหมด", cameras.data?.length, () => setSel({ kind: "all" }))}
          <p className="px-2 pt-1 text-[10px] leading-tight text-zinc-600">โหลดเฉพาะกล้องที่เห็นบนจอ เลื่อนเพื่อโหลดเพิ่ม</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-ink-800 bg-ink-900/40 px-4 py-2.5">
          <div className="font-display text-sm font-semibold text-cream">{title} <span className="ml-2 text-xs font-normal text-zinc-500">{visible.length} กล้อง</span></div>
          <div className="flex items-center gap-3 text-xs text-zinc-400">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={onlyOnline} onChange={(e) => setOnlyOnline(e.target.checked)} /> เฉพาะออนไลน์</label>
            {!selGroup && (
              <div className="flex items-center gap-0.5 rounded-lg border border-ink-700 p-0.5">
                {COLS.map((c) => (
                  <button key={c} onClick={() => setCols(c)} className={clsx("rounded px-2 py-0.5", c === cols ? "bg-gold-500 text-ink-950" : "hover:bg-ink-800")}>{c}×</button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {sel && visible.length === 0 && <div className="p-8 text-center text-sm text-zinc-500">ไม่มีกล้องในกลุ่มนี้</div>}
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}>
            {visible.map((c) => (
              <div key={c.id} className="group relative aspect-video overflow-hidden rounded-lg border border-ink-800 bg-black">
                {c.status === "OFFLINE" ? (
                  <div className="flex h-full items-center justify-center text-xs text-zinc-600">OFFLINE</div>
                ) : c.protocol === "NVR_CHANNEL" && !c.nvrChannel ? (
                  <div className="flex h-full items-center justify-center px-2 text-center text-xs text-amber-500/80">ยังไม่ระบุช่อง NVR</div>
                ) : (
                  <LazyVisible className="absolute inset-0 h-full w-full" rootMargin="200px" placeholder={<div className="grid h-full w-full place-items-center text-ink-600"><Video size={20} className="opacity-30" /></div>}>
                    <LivePlayer go2rtcUrl={c.streams.go2rtcUrl} stream={c.streams.sub} />
                  </LazyVisible>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-transparent px-2 py-1 text-[11px] text-zinc-200">
                  <StatusDot status={c.status} />
                  <span className="font-medium">{c.deviceNo}</span>
                  <span className="truncate text-zinc-400">{c.name}</span>
                </div>
                <button onClick={() => setFocus(c)} className="absolute right-1 top-1 z-10 rounded bg-black/60 p-1 text-zinc-300 opacity-0 hover:text-gold-300 group-hover:opacity-100" title="ขยาย"><Maximize2 size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
      {focus && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black">
          <div className="flex items-center justify-between px-4 py-2 text-sm">
            <div><span className="font-semibold text-cream">{focus.deviceNo}</span> <span className="text-zinc-400">{focus.name}</span> <span className="ml-2 text-xs text-zinc-500">{focus.floor?.name} · {focus.room?.name}</span></div>
            <button onClick={() => setFocus(null)} className="rounded p-1 hover:bg-ink-800"><X size={18} /></button>
          </div>
          <div className="min-h-0 flex-1"><LivePlayer go2rtcUrl={focus.streams.go2rtcUrl} stream={focus.streams.main} /></div>
        </div>
      )}
    </div>
  );
}
