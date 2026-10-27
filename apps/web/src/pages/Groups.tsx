import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { Camera, CameraGroup } from "../types";
import { Button, Field, Input, Modal, PageHeader, Select } from "../components/ui";
import { useAuth } from "../lib/auth";

type Form = { id?: number; name: string; description: string; gridColumns: number; cameraIds: number[] };

export function Groups() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api<CameraGroup[]>("/api/groups") });
  const cameras = useQuery({ queryKey: ["cameras", "all"], queryFn: () => api<Camera[]>("/api/cameras") });
  const [edit, setEdit] = useState<Form | null>(null);
  const [q, setQ] = useState("");
  const save = useMutation({
    mutationFn: (f: Form) => (f.id ? api(`/api/groups/${f.id}`, { method: "PATCH", json: f }) : api("/api/groups", { method: "POST", json: f })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["groups"] }); setEdit(null); },
  });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/groups/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }) });

  const pool = useMemo(() => (cameras.data ?? []).filter((c) => !q || `${c.deviceNo} ${c.name} ${c.floor?.name} ${c.room?.name}`.toLowerCase().includes(q.toLowerCase())), [cameras.data, q]);
  const toggle = (id: number) => edit && setEdit({ ...edit, cameraIds: edit.cameraIds.includes(id) ? edit.cameraIds.filter((x) => x !== id) : [...edit.cameraIds, id] });

  return (
    <div>
      <PageHeader title="กลุ่มกล้อง (กำหนดเอง)">{can("OPERATOR") && <Button onClick={() => setEdit({ name: "", description: "", gridColumns: 4, cameraIds: [] })}><Plus size={14} /> สร้างกลุ่ม</Button>}</PageHeader>
      <div className="grid gap-3 p-5 md:grid-cols-2 lg:grid-cols-3">
        {groups.data?.map((g) => (
          <div key={g.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex items-start justify-between">
              <div><div className="font-semibold">{g.name}</div><div className="text-xs text-zinc-500">{g.description}</div></div>
              <div className="text-xs text-zinc-500">{g.gridColumns}× · {g.members.length} กล้อง</div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">{g.members.slice(0, 12).map((m) => <span key={m.id} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]">{m.deviceNo}</span>)}{g.members.length > 12 && <span className="text-[11px] text-zinc-500">+{g.members.length - 12}</span>}</div>
            {can("OPERATOR") && (
              <div className="mt-3 flex justify-end gap-2 text-xs">
                <button className="text-blue-400 hover:underline" onClick={() => setEdit({ id: g.id, name: g.name, description: g.description ?? "", gridColumns: g.gridColumns, cameraIds: g.members.map((m) => m.id) })}>แก้ไข</button>
                <button className="flex items-center gap-1 text-red-400 hover:underline" onClick={() => confirm(`ลบกลุ่ม ${g.name}?`) && del.mutate(g.id)}><Trash2 size={12} /> ลบ</button>
              </div>
            )}
          </div>
        ))}
        {groups.data?.length === 0 && <div className="text-sm text-zinc-500">ยังไม่มีกลุ่ม กดสร้างกลุ่มเพื่อจัดกล้องข้าม NVR ได้อิสระ</div>}
      </div>
      {edit && (
        <Modal title={edit.id ? "แก้ไขกลุ่ม" : "สร้างกลุ่ม"} onClose={() => setEdit(null)} wide>
          <div className="grid grid-cols-3 gap-3">
            <Field label="ชื่อกลุ่ม"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="คำอธิบาย"><Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <Field label="คอลัมน์ในตาราง Live"><Select value={edit.gridColumns} onChange={(e) => setEdit({ ...edit, gridColumns: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
          </div>
          <div className="mt-3 flex items-center justify-between"><div className="text-xs text-zinc-400">เลือกแล้ว {edit.cameraIds.length} กล้อง</div><Input className="w-64" placeholder="ค้นหากล้อง" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="mt-2 max-h-80 overflow-auto rounded border border-zinc-800">
            {pool.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 border-b border-zinc-800/60 px-3 py-1 text-sm hover:bg-zinc-800/50">
                <input type="checkbox" checked={edit.cameraIds.includes(c.id)} onChange={() => toggle(c.id)} />
                <span className="w-16 font-medium">{c.deviceNo}</span>
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-xs text-zinc-500">{c.floor?.name} / {c.room?.name}</span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setEdit(null)}>ยกเลิก</Button><Button onClick={() => save.mutate(edit)} disabled={save.isPending || !edit.name}>บันทึก</Button></div>
        </Modal>
      )}
    </div>
  );
}
