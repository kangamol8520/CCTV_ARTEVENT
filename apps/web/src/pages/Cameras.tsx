import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, RefreshCw } from "lucide-react";
import { api, download, qs } from "../lib/api";
import type { Camera, FloorNode, Nvr } from "../types";
import { Button, Field, Input, Modal, PageHeader, Select, StatusDot, Textarea, fmtDate } from "../components/ui";
import { useAuth } from "../lib/auth";

type Form = Partial<Camera> & { password?: string };
const PROTOCOLS = ["HIKVISION", "ONVIF", "RTSP", "NVR_CHANNEL"];
const BRANDS = ["HIKVISION", "HILOOK", "TPLINK", "BELKO", "DAHUA", "UNKNOWN"];

export function Cameras() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [filter, setFilter] = useState({ q: "", floorId: "", nvrId: "", status: "", flagged: false });
  const cams = useQuery({ queryKey: ["cameras", filter.q, filter.floorId, filter.nvrId, filter.status], queryFn: () => api<Camera[]>(`/api/cameras${qs({ q: filter.q, floorId: filter.floorId, nvrId: filter.nvrId, status: filter.status })}`) });
  const tree = useQuery({ queryKey: ["locations-tree"], queryFn: () => api<FloorNode[]>("/api/locations/tree") });
  const nvrs = useQuery({ queryKey: ["nvrs"], queryFn: () => api<Nvr[]>("/api/nvrs") });
  const [edit, setEdit] = useState<Form | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (f: Form) => {
      const body = {
        deviceNo: f.deviceNo, name: f.name, description: f.description ?? null, brand: f.brand, protocol: f.protocol, host: f.host || null,
        rtspPort: Number(f.rtspPort ?? 554), httpPort: Number(f.httpPort ?? 80), username: f.username || null, password: f.password || undefined,
        mainStreamPath: f.mainStreamPath || null, subStreamPath: f.subStreamPath || null, nvrId: f.nvrId ? Number(f.nvrId) : null,
        nvrChannel: f.nvrChannel ? Number(f.nvrChannel) : null, floorId: f.floorId ? Number(f.floorId) : null, roomId: f.roomId ? Number(f.roomId) : null,
        isEnabled: f.isEnabled ?? true, importFlags: f.importFlags ?? null,
      };
      return f.id ? api(`/api/cameras/${f.id}`, { method: "PATCH", json: body }) : api("/api/cameras", { method: "POST", json: body });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cameras"] }); qc.invalidateQueries({ queryKey: ["locations-tree"] }); setEdit(null); setErr(null); },
    onError: (e) => setErr((e as Error).message),
  });
  const probe = useMutation({ mutationFn: (id: number) => api(`/api/cameras/${id}/probe`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }) });
  const healthAll = useMutation({ mutationFn: () => api("/api/system/health-check", { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }) });
  const syncAll = useMutation({ mutationFn: () => api<{ synced: number; skipped: unknown[] }>("/api/system/sync-streams", { method: "POST" }), onSuccess: (r) => alert(`ลงทะเบียนสตรีมแล้ว ${r.synced} กล้อง, ข้าม ${r.skipped.length}`) });

  const rooms = tree.data?.find((f) => f.id === Number(edit?.floorId))?.rooms ?? [];
  const list = (cams.data ?? []).filter((c) => !filter.flagged || c.importFlags);

  return (
    <div>
      <PageHeader title="ทะเบียนกล้อง">
        <Button variant="ghost" onClick={() => healthAll.mutate()} disabled={healthAll.isPending}><RefreshCw size={14} /> ตรวจสถานะทั้งหมด</Button>
        {can("OPERATOR") && <Button variant="ghost" onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>Sync go2rtc</Button>}
        <Button variant="ghost" onClick={() => download("/api/reports/cameras.xlsx", "camera-inventory.xlsx")}><Download size={14} /> Export</Button>
        {can("ADMIN") && <Button onClick={() => setEdit({ protocol: "HIKVISION", brand: "HIKVISION", rtspPort: 554, httpPort: 80, isEnabled: true })}><Plus size={14} /> เพิ่มกล้อง</Button>}
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <Input placeholder="ค้นหา รหัส / ชื่อ / IP" className="w-56" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        <Select className="w-40" value={filter.floorId} onChange={(e) => setFilter({ ...filter, floorId: e.target.value })}><option value="">ทุกชั้น</option>{tree.data?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
        <Select className="w-44" value={filter.nvrId} onChange={(e) => setFilter({ ...filter, nvrId: e.target.value })}><option value="">ทุก NVR</option>{nvrs.data?.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</Select>
        <Select className="w-32" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}><option value="">ทุกสถานะ</option><option>ONLINE</option><option>OFFLINE</option><option>UNKNOWN</option></Select>
        <label className="flex items-center gap-1 text-xs text-zinc-400"><input type="checkbox" checked={filter.flagged} onChange={(e) => setFilter({ ...filter, flagged: e.target.checked })} /> เฉพาะที่ต้องแก้ไข</label>
        <span className="ml-auto text-xs text-zinc-500">{list.length} รายการ</span>
      </div>
      <div className="px-5 pb-5">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500"><tr><th className="py-1">สถานะ</th><th>รหัส</th><th>ชื่อ</th><th>ชั้น / ห้อง</th><th>ยี่ห้อ</th><th>โปรโตคอล</th><th>IP</th><th>NVR</th><th>ช่อง</th><th>Flags</th><th></th></tr></thead>
          <tbody className="divide-y divide-zinc-800/80">
            {list.map((c) => (
              <tr key={c.id} className={!c.isEnabled ? "opacity-50" : ""}>
                <td className="py-1.5"><StatusDot status={c.status} /></td>
                <td className="font-medium">{c.deviceNo}</td>
                <td className="max-w-xs truncate" title={c.description ?? ""}>{c.name}</td>
                <td className="text-zinc-400">{c.floor?.name} / {c.room?.name}</td>
                <td className="text-zinc-400">{c.brand}</td>
                <td className="text-zinc-400">{c.protocol}</td>
                <td className="font-mono text-xs">{c.host ?? "-"}</td>
                <td className="text-zinc-400">{c.nvr?.name ?? "-"}</td>
                <td>{c.nvrChannel ?? "-"}</td>
                <td className="text-xs text-amber-400">{c.importFlags}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="text-xs text-zinc-400 hover:text-white" onClick={() => probe.mutate(c.id)} title={`last seen ${fmtDate(c.lastSeenAt)}`}>ตรวจ</button>
                  {can("OPERATOR") && <button className="ml-2 text-xs text-blue-400 hover:underline" onClick={() => setEdit({ ...c })}>แก้ไข</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? `แก้ไขกล้อง ${edit.deviceNo}` : "เพิ่มกล้อง"} onClose={() => setEdit(null)} wide>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Field label="รหัสกล้อง"><Input value={edit.deviceNo ?? ""} onChange={(e) => setEdit({ ...edit, deviceNo: e.target.value })} /></Field>
            <Field label="ชื่อ" className="md:col-span-2"><Input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="ยี่ห้อ"><Select value={edit.brand ?? "UNKNOWN"} onChange={(e) => setEdit({ ...edit, brand: e.target.value })}>{BRANDS.map((b) => <option key={b}>{b}</option>)}</Select></Field>
            <Field label="โปรโตคอล"><Select value={edit.protocol ?? "ONVIF"} onChange={(e) => setEdit({ ...edit, protocol: e.target.value as Camera["protocol"] })}>{PROTOCOLS.map((p) => <option key={p}>{p}</option>)}</Select></Field>
            <Field label="เปิดใช้งาน"><Select value={edit.isEnabled === false ? "0" : "1"} onChange={(e) => setEdit({ ...edit, isEnabled: e.target.value === "1" })}><option value="1">ใช้งาน</option><option value="0">ปิด</option></Select></Field>
            <Field label="IP (เว้นว่างถ้า Plug & Play)"><Input value={edit.host ?? ""} onChange={(e) => setEdit({ ...edit, host: e.target.value })} /></Field>
            <Field label="RTSP port"><Input type="number" value={edit.rtspPort ?? 554} onChange={(e) => setEdit({ ...edit, rtspPort: Number(e.target.value) })} /></Field>
            <Field label="HTTP port"><Input type="number" value={edit.httpPort ?? 80} onChange={(e) => setEdit({ ...edit, httpPort: Number(e.target.value) })} /></Field>
            <Field label="Username"><Input value={edit.username ?? ""} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></Field>
            <Field label="Password (เว้นว่าง = ไม่เปลี่ยน)"><Input type="password" value={edit.password ?? ""} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            <div />
            <Field label="NVR"><Select value={edit.nvrId ?? ""} onChange={(e) => setEdit({ ...edit, nvrId: e.target.value ? Number(e.target.value) : null })}><option value="">-</option>{nvrs.data?.map((n) => <option key={n.id} value={n.id}>{n.name} ({n.host})</option>)}</Select></Field>
            <Field label="ช่องบน NVR (1-based)"><Input type="number" value={edit.nvrChannel ?? ""} onChange={(e) => setEdit({ ...edit, nvrChannel: e.target.value ? Number(e.target.value) : null })} /></Field>
            <div />
            <Field label="ชั้น"><Select value={edit.floorId ?? ""} onChange={(e) => setEdit({ ...edit, floorId: e.target.value ? Number(e.target.value) : null, roomId: null })}><option value="">-</option>{tree.data?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></Field>
            <Field label="ห้อง"><Select value={edit.roomId ?? ""} onChange={(e) => setEdit({ ...edit, roomId: e.target.value ? Number(e.target.value) : null })}><option value="">-</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
            <div />
            {edit.protocol === "RTSP" && (<>
              <Field label="Main stream path"><Input value={edit.mainStreamPath ?? ""} onChange={(e) => setEdit({ ...edit, mainStreamPath: e.target.value })} placeholder="/stream1" /></Field>
              <Field label="Sub stream path"><Input value={edit.subStreamPath ?? ""} onChange={(e) => setEdit({ ...edit, subStreamPath: e.target.value })} placeholder="/stream2" /></Field>
              <div />
            </>)}
            <Field label="รายละเอียด / ตำแหน่งติดตั้ง" className="col-span-2 md:col-span-3"><Textarea rows={2} value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <Field label="Import flags (ลบออกเมื่อแก้ไขแล้ว)" className="col-span-2 md:col-span-3"><Input value={edit.importFlags ?? ""} onChange={(e) => setEdit({ ...edit, importFlags: e.target.value || null })} /></Field>
          </div>
          {err && <div className="mt-3 text-sm text-red-400">{err}</div>}
          <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setEdit(null)}>ยกเลิก</Button><Button onClick={() => save.mutate(edit)} disabled={save.isPending}>บันทึก</Button></div>
        </Modal>
      )}
    </div>
  );
}
