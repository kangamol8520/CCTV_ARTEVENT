import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import GridLayout, { WidthProvider, type Layout as RglLayout } from "react-grid-layout";
import { ChevronRight, Clock, Film, Pencil, Plus, Save, Search, Trash2, Tv, X } from "lucide-react";
import clsx from "clsx";
import { api } from "../lib/api";
import type { Camera, FloorNode, LayoutConfig, LayoutItem, VideoLayout } from "../types";
import { LivePlayer } from "../components/LivePlayer";
import { CameraThumb } from "../components/CameraThumb";
import { Button, Field, Input, Modal, StatusDot, toLocalInput } from "../components/ui";
import { useAuth } from "../lib/auth";

const Grid = WidthProvider(GridLayout);
const COLS = 12;
const ROW_H = 44;

type Mode = "live" | "playback";
interface PlaybackStream { stream: string; go2rtcUrl: string }

/** One tile: live stream, or (in playback mode) the time-boxed NVR stream once loaded. */
function Tile({ cam, mode, playback, editing, onRemove }: { cam: Camera; mode: Mode; playback?: PlaybackStream; editing: boolean; onRemove: () => void }) {
  const showPlayback = mode === "playback";
  return (
    <div className="group relative h-full w-full overflow-hidden rounded-lg border border-ink-800 bg-black">
      {cam.status === "OFFLINE" && mode === "live" ? (
        <div className="grid h-full place-items-center text-xs text-zinc-600">OFFLINE</div>
      ) : showPlayback ? (
        playback ? <LivePlayer go2rtcUrl={playback.go2rtcUrl} stream={playback.stream} mode="mse" controls /> : <div className="grid h-full place-items-center text-xs text-zinc-600">รอโหลดย้อนหลัง…</div>
      ) : (
        <LivePlayer go2rtcUrl={cam.streams.go2rtcUrl} stream={cam.streams.sub} />
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1.5 bg-gradient-to-b from-black/80 to-transparent px-2 py-1 text-[11px] text-zinc-200">
        <StatusDot status={cam.status} />
        <span className="font-medium">{cam.deviceNo}</span>
        <span className="truncate text-zinc-400">{cam.name}</span>
      </div>
      {editing && (
        <button onClick={onRemove} className="drag-cancel absolute right-1 top-1 z-10 rounded bg-black/70 p-1 text-zinc-300 opacity-0 hover:text-red-300 group-hover:opacity-100" title="เอาออก">
          <X size={13} />
        </button>
      )}
    </div>
  );
}

const emptyConfig = (): LayoutConfig => ({ items: [], cols: COLS, rowHeight: ROW_H });

export function Layouts() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const layouts = useQuery({ queryKey: ["layouts"], queryFn: () => api<VideoLayout[]>("/api/layouts") });
  const cameras = useQuery({ queryKey: ["cameras", "all"], queryFn: () => api<Camera[]>("/api/cameras") });
  const tree = useQuery({ queryKey: ["locations-tree"], queryFn: () => api<FloorNode[]>("/api/locations/tree") });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setExpanded((e) => ({ ...e, [k]: !e[k] }));

  const [currentId, setCurrentId] = useState<number | null>(null);
  const [name, setName] = useState("เลย์เอาต์ใหม่");
  const [config, setConfig] = useState<LayoutConfig>(emptyConfig());
  const [editing, setEditing] = useState(true);
  const [mode, setMode] = useState<Mode>("live");
  const [dirty, setDirty] = useState(false);
  const [picker, setPicker] = useState("");
  const [saveAs, setSaveAs] = useState(false);

  // playback state
  const [pbFrom, setPbFrom] = useState(toLocalInput(new Date(Date.now() - 3600_000)));
  const [pbStreams, setPbStreams] = useState<Record<number, PlaybackStream>>({});
  const openedRef = useRef<string[]>([]);

  const camById = useMemo(() => new Map((cameras.data ?? []).map((c) => [c.id, c])), [cameras.data]);
  const itemsCams = config.items.map((it) => camById.get(it.cameraId)).filter(Boolean) as Camera[];
  const usedIds = new Set(config.items.map((i) => i.cameraId));

  function loadLayout(l: VideoLayout) {
    releasePlayback();
    setCurrentId(l.id); setName(l.name); setConfig(l.config?.items ? l.config : emptyConfig());
    setEditing(false); setMode("live"); setDirty(false);
  }
  function newLayout() {
    releasePlayback();
    setCurrentId(null); setName("เลย์เอาต์ใหม่"); setConfig(emptyConfig()); setEditing(true); setMode("live"); setDirty(false);
  }

  const rglLayout: RglLayout[] = config.items.map((it) => ({ i: String(it.cameraId), x: it.x, y: it.y, w: it.w, h: it.h, minW: 2, minH: 3 }));

  function onLayoutChange(next: RglLayout[]) {
    if (!editing) return;
    const items: LayoutItem[] = next.map((n) => ({ cameraId: Number(n.i), x: n.x, y: n.y, w: n.w, h: n.h }));
    setConfig((c) => ({ ...c, items }));
    setDirty(true);
  }
  function addCamera(cam: Camera) {
    if (usedIds.has(cam.id)) return;
    const y = config.items.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    const count = config.items.length;
    setConfig((c) => ({ ...c, items: [...c.items, { cameraId: cam.id, x: (count * 3) % COLS, y, w: 3, h: 4 }] }));
    setDirty(true);
  }
  function removeCamera(id: number) {
    setConfig((c) => ({ ...c, items: c.items.filter((i) => i.cameraId !== id) }));
    setDirty(true);
  }

  const save = useMutation({
    mutationFn: async (asName?: string) => {
      const body = { name: asName ?? name, config };
      if (currentId && !asName) return api<VideoLayout>(`/api/layouts/${currentId}`, { method: "PUT", json: body });
      return api<VideoLayout>("/api/layouts", { method: "POST", json: body });
    },
    onSuccess: (l) => { qc.invalidateQueries({ queryKey: ["layouts"] }); setCurrentId(l.id); setName(l.name); setDirty(false); setSaveAs(false); },
    onError: (e) => alert((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/api/layouts/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["layouts"] }); newLayout(); },
  });

  // ─── synchronized playback ───
  function releasePlayback() {
    for (const name of openedRef.current) api(`/api/playback/stream/${name}`, { method: "DELETE" }).catch(() => {});
    openedRef.current = [];
    setPbStreams({});
  }
  const loadPlayback = useMutation({
    mutationFn: async () => {
      releasePlayback();
      const from = new Date(pbFrom);
      const to = new Date(from.getTime() + 60 * 60_000);
      const out: Record<number, PlaybackStream> = {};
      const opened: string[] = [];
      await Promise.all(itemsCams.map(async (cam) => {
        try {
          const r = await api<{ stream: string; go2rtcUrl: string }>(`/api/playback/${cam.id}/stream`, { method: "POST", json: { from: from.toISOString(), to: to.toISOString() } });
          out[cam.id] = r; opened.push(r.stream);
        } catch { /* camera not NVR-backed; skip */ }
      }));
      openedRef.current = opened;
      return out;
    },
    onSuccess: (out) => setPbStreams(out),
    onError: (e) => alert((e as Error).message),
  });
  useEffect(() => () => releasePlayback(), []); // cleanup on unmount

  function switchMode(m: Mode) {
    if (m === mode) return;
    if (m === "live") releasePlayback();
    setMode(m);
  }

  const pool = (cameras.data ?? []).filter((c) => !picker || `${c.deviceNo} ${c.name} ${c.floor?.name} ${c.room?.name}`.toLowerCase().includes(picker.toLowerCase()));

  return (
    <div className="flex h-full">
      {/* left rail: saved layouts + camera picker */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900/60">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-display text-sm font-semibold text-cream">เลย์เอาต์ที่บันทึก</span>
          {can("OPERATOR") && <button onClick={newLayout} className="text-gold-400 hover:text-gold-300" title="สร้างใหม่"><Plus size={16} /></button>}
        </div>
        <div className="max-h-56 overflow-auto px-2">
          {layouts.data?.map((l) => (
            <button key={l.id} onClick={() => loadLayout(l)} className={clsx("flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm", currentId === l.id ? "bg-ink-800 text-cream ring-1 ring-gold-700/50" : "text-zinc-400 hover:bg-ink-850")}>
              <span className="truncate">{l.name}</span>
              <span className="text-[11px] text-zinc-600">{l.config?.items?.length ?? 0}</span>
            </button>
          ))}
          {layouts.data?.length === 0 && <div className="px-3 py-2 text-xs text-zinc-600">ยังไม่มีเลย์เอาต์</div>}
        </div>

        {editing && (
          <div className="flex min-h-0 flex-1 flex-col border-t border-ink-800">
            <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
              <Search size={13} className="text-zinc-500" />
              <input value={picker} onChange={(e) => setPicker(e.target.value)} placeholder="ค้นหากล้องเพื่อเพิ่ม" className="w-full bg-transparent text-xs text-cream outline-none placeholder:text-zinc-600" />
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {picker ? (
                pool.map((c) => <CamRow key={c.id} cam={c} used={usedIds.has(c.id)} onAdd={() => addCamera(c)} />)
              ) : (
                tree.data?.map((f) => {
                  const fk = `f${f.id}`;
                  return (
                    <div key={f.id}>
                      <button onClick={() => toggle(fk)} className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs font-medium text-zinc-300 hover:bg-ink-850">
                        <ChevronRight size={13} className={clsx("transition-transform", expanded[fk] && "rotate-90")} />
                        <span className="flex-1 truncate">{f.name}</span>
                        <span className="text-[10px] text-zinc-600">{f.cameraCount}</span>
                      </button>
                      {expanded[fk] && f.rooms.filter((r) => r.cameraCount > 0).map((r) => {
                        const rk = `r${r.id}`;
                        const roomCams = (cameras.data ?? []).filter((c) => c.roomId === r.id);
                        return (
                          <div key={r.id} className="ml-3">
                            <button onClick={() => toggle(rk)} className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-zinc-400 hover:bg-ink-850">
                              <ChevronRight size={12} className={clsx("transition-transform", expanded[rk] && "rotate-90")} />
                              <span className="flex-1 truncate">{r.name}</span>
                              <span className="text-[10px] text-zinc-600">{r.cameraCount}</span>
                            </button>
                            {expanded[rk] && <div className="ml-1 grid grid-cols-2 gap-1.5 py-1">{roomCams.map((c) => <CamCard key={c.id} cam={c} used={usedIds.has(c.id)} onAdd={() => addCamera(c)} />)}</div>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </aside>

      {/* main stage */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 bg-ink-900/40 px-5 py-2.5">
          {editing ? (
            <Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} className="w-56 font-display" />
          ) : (
            <h1 className="font-display text-base font-semibold text-cream">{name}</h1>
          )}
          <span className="text-xs text-zinc-500">{config.items.length} กล้อง</span>

          <div className="ml-auto flex items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-ink-700">
              <button onClick={() => switchMode("live")} className={clsx("flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium", mode === "live" ? "bg-gold-500 text-ink-950" : "text-zinc-400 hover:bg-ink-800")}><Tv size={14} /> สด</button>
              <button onClick={() => switchMode("playback")} className={clsx("flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium", mode === "playback" ? "bg-gold-500 text-ink-950" : "text-zinc-400 hover:bg-ink-800")}><Film size={14} /> ย้อนหลัง</button>
            </div>
            {can("OPERATOR") && (
              <Button variant={editing ? "primary" : "ghost"} onClick={() => setEditing((v) => !v)}><Pencil size={14} /> {editing ? "กำลังแก้ไข" : "แก้ไข"}</Button>
            )}
            {can("OPERATOR") && <Button variant="gold" onClick={() => save.mutate(undefined)} disabled={save.isPending || (!dirty && !!currentId)}><Save size={14} /> บันทึก</Button>}
            {can("OPERATOR") && config.items.length > 0 && <Button variant="ghost" onClick={() => setSaveAs(true)}>บันทึกเป็น…</Button>}
            {can("OPERATOR") && currentId && <Button variant="danger" onClick={() => confirm(`ลบเลย์เอาต์ "${name}"?`) && del.mutate(currentId)}><Trash2 size={14} /></Button>}
          </div>
        </div>

        {mode === "playback" && (
          <div className="flex flex-wrap items-center gap-3 border-b border-ink-800 bg-ink-850 px-5 py-2">
            <Clock size={15} className="text-gold-400" />
            <Field label="เริ่มเวลา" className="!text-zinc-400"><Input type="datetime-local" value={pbFrom} onChange={(e) => setPbFrom(e.target.value)} className="w-52" /></Field>
            <Button variant="gold" onClick={() => loadPlayback.mutate()} disabled={loadPlayback.isPending}>{loadPlayback.isPending ? "กำลังโหลด…" : "เล่นย้อนหลังทั้งเลย์เอาต์"}</Button>
            <span className="text-xs text-zinc-500">ดึงจาก NVR พร้อมกันทุกกล้อง · หน้าต่าง 1 ชั่วโมง</span>
            {Object.keys(pbStreams).length > 0 && <span className="text-xs text-emerald-400">กำลังเล่น {Object.keys(pbStreams).length} กล้อง</span>}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {config.items.length === 0 ? (
            <div className="grid h-full place-items-center text-center text-sm text-zinc-600">
              <div>
                <p>ยังไม่มีกล้องในเลย์เอาต์นี้</p>
                {editing ? <p className="mt-1 text-xs">เลือกกล้องจากแถบด้านซ้ายเพื่อเพิ่ม แล้วลากมุมเพื่อยืดหดขนาด</p> : <p className="mt-1 text-xs">กดปุ่มแก้ไขเพื่อเพิ่มกล้อง</p>}
              </div>
            </div>
          ) : (
            <Grid
              className="layout"
              layout={rglLayout}
              cols={COLS}
              rowHeight={ROW_H}
              margin={[8, 8]}
              isDraggable={editing}
              isResizable={editing}
              draggableCancel=".drag-cancel"
              onLayoutChange={onLayoutChange}
              compactType={null}
              preventCollision
            >
              {itemsCams.map((cam) => (
                <div key={String(cam.id)}>
                  <Tile cam={cam} mode={mode} playback={pbStreams[cam.id]} editing={editing} onRemove={() => removeCamera(cam.id)} />
                </div>
              ))}
            </Grid>
          )}
        </div>
      </div>

      {saveAs && (
        <Modal title="บันทึกเป็นเลย์เอาต์ใหม่" onClose={() => setSaveAs(false)}>
          <SaveAsForm onSave={(nm) => save.mutate(nm)} busy={save.isPending} />
        </Modal>
      )}
    </div>
  );
}

/** Camera card with a preview snapshot, shown in the floor/room picker tree. */
function CamCard({ cam, used, onAdd }: { cam: Camera; used: boolean; onAdd: () => void }) {
  return (
    <button onClick={onAdd} disabled={used} className={clsx("group overflow-hidden rounded-lg border text-left", used ? "cursor-default border-ink-800 opacity-40" : "border-ink-700 hover:border-gold-600")}>
      <div className="relative aspect-video">
        <CameraThumb go2rtcUrl={cam.streams.go2rtcUrl} stream={cam.streams.sub} status={cam.status} className="h-full w-full" />
        {!used && <div className="absolute inset-0 grid place-items-center bg-black/0 text-cream opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100"><Plus size={18} /></div>}
        {used && <div className="absolute right-1 top-1 rounded bg-black/70 px-1 text-[9px] text-gold-300">เพิ่มแล้ว</div>}
      </div>
      <div className="flex items-center gap-1 px-1.5 py-1 text-[10px]">
        <StatusDot status={cam.status} />
        <span className="font-medium text-zinc-200">{cam.deviceNo}</span>
        <span className="truncate text-zinc-500">{cam.name}</span>
      </div>
    </button>
  );
}

/** Compact camera row with a thumbnail — used for flat search results. */
function CamRow({ cam, used, onAdd }: { cam: Camera; used: boolean; onAdd: () => void }) {
  return (
    <button onClick={onAdd} disabled={used} className={clsx("flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs", used ? "opacity-30" : "text-zinc-300 hover:bg-ink-800")}>
      <CameraThumb go2rtcUrl={cam.streams.go2rtcUrl} stream={cam.streams.sub} status={cam.status} className="h-7 w-12 shrink-0 rounded" />
      <span className="w-14 shrink-0 font-medium">{cam.deviceNo}</span>
      <span className="truncate">{cam.name}</span>
    </button>
  );
}

function SaveAsForm({ onSave, busy }: { onSave: (name: string) => void; busy: boolean }) {
  const [nm, setNm] = useState("");
  return (
    <div className="space-y-4">
      <Field label="ชื่อเลย์เอาต์"><Input value={nm} onChange={(e) => setNm(e.target.value)} autoFocus /></Field>
      <div className="flex justify-end"><Button variant="gold" disabled={!nm || busy} onClick={() => onSave(nm)}>บันทึก</Button></div>
    </div>
  );
}
