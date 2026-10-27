import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import type { Nvr } from "../types";
import { Button, Field, Input, Modal, PageHeader, Select, StatusDot, Textarea, fmtDate } from "../components/ui";
import { useAuth } from "../lib/auth";

type Form = Partial<Nvr> & { password?: string };

export function Nvrs() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const nvrs = useQuery({ queryKey: ["nvrs"], queryFn: () => api<Nvr[]>("/api/nvrs") });
  const [edit, setEdit] = useState<Form | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (f: Form) => {
      const body = { name: f.name, brand: f.brand, model: f.model || null, serialNo: f.serialNo || null, host: f.host, httpPort: Number(f.httpPort ?? 80), rtspPort: Number(f.rtspPort ?? 554), username: f.username || null, password: f.password || undefined, maxChannels: Number(f.maxChannels ?? 16), channelMainPath: f.channelMainPath, channelSubPath: f.channelSubPath, playbackPath: f.playbackPath, notes: f.notes || null };
      return f.id ? api(`/api/nvrs/${f.id}`, { method: "PATCH", json: body }) : api("/api/nvrs", { method: "POST", json: body });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["nvrs"] }); setEdit(null); setErr(null); },
    onError: (e) => setErr((e as Error).message),
  });
  const probe = useMutation({ mutationFn: (id: number) => api(`/api/nvrs/${id}/probe`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["nvrs"] }) });

  return (
    <div>
      <PageHeader title="เครื่องบันทึก (NVR)">{can("ADMIN") && <Button onClick={() => setEdit({ brand: "HIKVISION", httpPort: 80, rtspPort: 554, maxChannels: 16, channelMainPath: "/Streaming/Channels/{ch}01", channelSubPath: "/Streaming/Channels/{ch}02", playbackPath: "/Streaming/tracks/{ch}01?starttime={start}&endtime={end}" })}><Plus size={14} /> เพิ่ม NVR</Button>}</PageHeader>
      <div className="px-5 py-3">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500"><tr><th className="py-1">สถานะ</th><th>ชื่อ</th><th>รุ่น</th><th>IP</th><th>HTTP</th><th>RTSP</th><th>กล้อง</th><th>เห็นล่าสุด</th><th></th></tr></thead>
          <tbody className="divide-y divide-ink-800/80">
            {nvrs.data?.map((n) => (
              <tr key={n.id}>
                <td className="py-1.5"><StatusDot status={n.status} /></td>
                <td className="font-medium">{n.name}</td>
                <td className="text-zinc-400">{n.model ?? "-"}</td>
                <td className="font-mono text-xs">{n.host}</td>
                <td>{n.httpPort}</td><td>{n.rtspPort}</td>
                <td>{n._count.cameras} / {n.maxChannels}</td>
                <td className="text-xs text-zinc-500">{fmtDate(n.lastSeenAt)}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="text-xs text-zinc-400 hover:text-white" onClick={() => probe.mutate(n.id)}>ตรวจ</button>
                  {can("ADMIN") && <button className="ml-2 text-xs text-gold-400 hover:underline" onClick={() => setEdit({ ...n })}>แก้ไข</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? `แก้ไข ${edit.name}` : "เพิ่ม NVR"} onClose={() => setEdit(null)} wide>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Field label="ชื่อ"><Input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="ยี่ห้อ"><Select value={edit.brand ?? "HIKVISION"} onChange={(e) => setEdit({ ...edit, brand: e.target.value })}><option>HIKVISION</option><option>TPLINK</option><option>OTHER</option></Select></Field>
            <Field label="รุ่น"><Input value={edit.model ?? ""} onChange={(e) => setEdit({ ...edit, model: e.target.value })} /></Field>
            <Field label="IP"><Input value={edit.host ?? ""} onChange={(e) => setEdit({ ...edit, host: e.target.value })} /></Field>
            <Field label="HTTP port"><Input type="number" value={edit.httpPort ?? 80} onChange={(e) => setEdit({ ...edit, httpPort: Number(e.target.value) })} /></Field>
            <Field label="RTSP port"><Input type="number" value={edit.rtspPort ?? 554} onChange={(e) => setEdit({ ...edit, rtspPort: Number(e.target.value) })} /></Field>
            <Field label="Username"><Input value={edit.username ?? ""} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></Field>
            <Field label="Password (เว้นว่าง = ไม่เปลี่ยน)"><Input type="password" value={edit.password ?? ""} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            <Field label="จำนวนช่อง"><Input type="number" value={edit.maxChannels ?? 16} onChange={(e) => setEdit({ ...edit, maxChannels: Number(e.target.value) })} /></Field>
            <Field label="Main path ({ch})"><Input value={edit.channelMainPath ?? ""} onChange={(e) => setEdit({ ...edit, channelMainPath: e.target.value })} /></Field>
            <Field label="Sub path ({ch})"><Input value={edit.channelSubPath ?? ""} onChange={(e) => setEdit({ ...edit, channelSubPath: e.target.value })} /></Field>
            <Field label="Playback path"><Input value={edit.playbackPath ?? ""} onChange={(e) => setEdit({ ...edit, playbackPath: e.target.value })} /></Field>
            <Field label="Serial"><Input value={edit.serialNo ?? ""} onChange={(e) => setEdit({ ...edit, serialNo: e.target.value })} /></Field>
            <Field label="หมายเหตุ" className="col-span-2"><Textarea rows={2} value={edit.notes ?? ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          </div>
          {err && <div className="mt-3 text-sm text-red-400">{err}</div>}
          <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setEdit(null)}>ยกเลิก</Button><Button onClick={() => save.mutate(edit)} disabled={save.isPending}>บันทึก</Button></div>
        </Modal>
      )}
    </div>
  );
}
