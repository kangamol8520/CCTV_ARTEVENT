import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus } from "lucide-react";
import { api, download, qs } from "../lib/api";
import type { Camera, Event } from "../types";
import { Button, Field, Input, Modal, PageHeader, Select, Textarea, fmtDate, toLocalInput } from "../components/ui";
import { useAuth } from "../lib/auth";

const TYPES = ["INCIDENT", "INTRUSION", "ACCESS", "MAINTENANCE", "OTHER"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
type Form = { id?: number; cameraId: number | null; type: string; severity: string; title: string; description: string; startedAt: string; endedAt: string };

export function Events() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const today = new Date();
  const [filter, setFilter] = useState({ from: toLocalInput(new Date(today.getTime() - 7 * 86400000)), to: "", type: "", severity: "", cameraId: "" });
  const [page, setPage] = useState(1);
  const params = { from: filter.from ? new Date(filter.from).toISOString() : "", to: filter.to ? new Date(filter.to).toISOString() : "", type: filter.type, severity: filter.severity, cameraId: filter.cameraId };
  const events = useQuery({ queryKey: ["events", params, page], queryFn: () => api<{ total: number; items: Event[]; pageSize: number }>(`/api/events${qs({ ...params, page })}`) });
  const cameras = useQuery({ queryKey: ["cameras", "all"], queryFn: () => api<Camera[]>("/api/cameras") });
  const [edit, setEdit] = useState<Form | null>(null);
  const save = useMutation({
    mutationFn: (f: Form) => {
      const body = { ...f, startedAt: new Date(f.startedAt).toISOString(), endedAt: f.endedAt ? new Date(f.endedAt).toISOString() : null, description: f.description || null };
      return f.id ? api(`/api/events/${f.id}`, { method: "PATCH", json: body }) : api("/api/events", { method: "POST", json: body });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["events"] }); setEdit(null); },
  });
  const ack = useMutation({ mutationFn: (id: number) => api(`/api/events/${id}/acknowledge`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["events"] }) });
  const pages = events.data ? Math.max(1, Math.ceil(events.data.total / events.data.pageSize)) : 1;

  return (
    <div>
      <PageHeader title="บันทึกเหตุการณ์">
        <Button variant="ghost" onClick={() => download(`/api/reports/events.xlsx${qs(params)}`, "events.xlsx")}><Download size={14} /> Export Excel</Button>
        {can("OPERATOR") && <Button onClick={() => setEdit({ cameraId: null, type: "INCIDENT", severity: "MEDIUM", title: "", description: "", startedAt: toLocalInput(new Date()), endedAt: "" })}><Plus size={14} /> บันทึกเหตุการณ์</Button>}
      </PageHeader>
      <div className="flex flex-wrap items-end gap-2 px-5 py-3">
        <Field label="ตั้งแต่"><Input type="datetime-local" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></Field>
        <Field label="ถึง"><Input type="datetime-local" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></Field>
        <Field label="ประเภท"><Select className="w-36" value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}><option value="">ทั้งหมด</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label="ระดับ"><Select className="w-32" value={filter.severity} onChange={(e) => setFilter({ ...filter, severity: e.target.value })}><option value="">ทั้งหมด</option>{SEVERITIES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label="กล้อง"><Select className="w-48" value={filter.cameraId} onChange={(e) => setFilter({ ...filter, cameraId: e.target.value })}><option value="">ทั้งหมด</option>{cameras.data?.map((c) => <option key={c.id} value={c.id}>{c.deviceNo} {c.name}</option>)}</Select></Field>
        <span className="ml-auto text-xs text-zinc-500">{events.data?.total ?? 0} รายการ</span>
      </div>
      <div className="px-5 pb-5">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500"><tr><th className="py-1">เวลา</th><th>ระดับ</th><th>ประเภท</th><th>หัวข้อ</th><th>กล้อง</th><th>ผู้บันทึก</th><th>รับทราบ</th><th></th></tr></thead>
          <tbody className="divide-y divide-zinc-800/80">
            {events.data?.items.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap py-1.5 text-xs">{fmtDate(e.startedAt)}</td>
                <td><span className={`rounded px-1.5 py-0.5 text-xs ${e.severity === "CRITICAL" ? "bg-red-700 text-white" : e.severity === "HIGH" ? "bg-red-900/60 text-red-200" : e.severity === "MEDIUM" ? "bg-amber-900/50 text-amber-200" : "bg-zinc-800 text-zinc-300"}`}>{e.severity}</span></td>
                <td className="text-zinc-400">{e.type}</td>
                <td className="max-w-md truncate" title={e.description ?? ""}>{e.title}</td>
                <td className="text-zinc-400">{e.camera ? `${e.camera.deviceNo} · ${e.camera.room?.name ?? ""}` : "-"}</td>
                <td className="text-xs text-zinc-500">{e.createdBy?.displayName}</td>
                <td className="text-xs text-zinc-500">{e.acknowledgedBy ? e.acknowledgedBy.displayName : can("OPERATOR") ? <button className="text-blue-400 hover:underline" onClick={() => ack.mutate(e.id)}>รับทราบ</button> : "-"}</td>
                <td className="text-right">{can("OPERATOR") && <button className="text-xs text-blue-400 hover:underline" onClick={() => setEdit({ id: e.id, cameraId: e.cameraId, type: e.type, severity: e.severity, title: e.title, description: e.description ?? "", startedAt: toLocalInput(new Date(e.startedAt)), endedAt: e.endedAt ? toLocalInput(new Date(e.endedAt)) : "" })}>แก้ไข</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pages > 1 && <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400"><Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>ก่อนหน้า</Button>หน้า {page} / {pages}<Button variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>ถัดไป</Button></div>}
      </div>
      {edit && (
        <Modal title={edit.id ? "แก้ไขเหตุการณ์" : "บันทึกเหตุการณ์"} onClose={() => setEdit(null)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="หัวข้อ" className="col-span-2"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="ประเภท"><Select value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
            <Field label="ระดับ"><Select value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value })}>{SEVERITIES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
            <Field label="กล้อง" className="col-span-2"><Select value={edit.cameraId ?? ""} onChange={(e) => setEdit({ ...edit, cameraId: e.target.value ? Number(e.target.value) : null })}><option value="">-</option>{cameras.data?.map((c) => <option key={c.id} value={c.id}>{c.deviceNo} {c.name} ({c.floor?.name})</option>)}</Select></Field>
            <Field label="เริ่ม"><Input type="datetime-local" value={edit.startedAt} onChange={(e) => setEdit({ ...edit, startedAt: e.target.value })} /></Field>
            <Field label="สิ้นสุด"><Input type="datetime-local" value={edit.endedAt} onChange={(e) => setEdit({ ...edit, endedAt: e.target.value })} /></Field>
            <Field label="รายละเอียด" className="col-span-2"><Textarea rows={4} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          </div>
          <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setEdit(null)}>ยกเลิก</Button><Button onClick={() => save.mutate(edit)} disabled={save.isPending || !edit.title}>บันทึก</Button></div>
        </Modal>
      )}
    </div>
  );
}
