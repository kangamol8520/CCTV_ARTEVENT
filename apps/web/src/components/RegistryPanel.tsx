import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Wrench } from "lucide-react";
import { api } from "../lib/api";
import { Button, Field, Input, Modal, Select } from "./ui";
import clsx from "clsx";
import { useAuth } from "../lib/auth";

interface RegistryResp { linked: boolean; registryId?: number; detail?: { dataDevice?: Record<string, unknown>; UserLogin?: { UserLogin?: string; LoginType?: string }[] } }
interface Repair { BillDoc?: string; JobDate?: string; FinishDate?: string; StatusName?: string; BrokenDes?: string; RepairDes?: string; EmpFullName?: string; RepairPrice?: number; PartPrice?: number }
const s = (v: unknown) => (v === null || v === undefined || v === "" ? "-" : String(v));
const d = (v: unknown) => { const x = v ? new Date(String(v)) : null; return x && !isNaN(x.getTime()) && x.getFullYear() > 2000 ? x.toLocaleDateString("th-TH") : "-"; };
const dt = (v: unknown) => { const x = v ? new Date(String(v)) : null; return x && !isNaN(x.getTime()) && x.getFullYear() > 2000 ? x.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "-"; };

/** View + edit the device-registry record for a camera (write-back to webae). */
export function RegistryPanel({ cameraId, deviceNo, onClose }: { cameraId: number; deviceNo: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const reg = useQuery({ queryKey: ["registry", cameraId], queryFn: () => api<RegistryResp>(`/api/registry/cameras/${cameraId}`) });
  const [edit, setEdit] = useState<{ IPv4_1: string; Desciption: string; Status1: string } | null>(null);
  const [repairs, setRepairs] = useState<Repair[] | null>(null);

  const dd = reg.data?.detail?.dataDevice ?? {};
  const save = useMutation({
    mutationFn: (body: Record<string, string>) => api<{ ipChanged: boolean }>(`/api/registry/cameras/${cameraId}`, { method: "PUT", json: body }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["registry", cameraId] }); qc.invalidateQueries({ queryKey: ["cameras"] }); setEdit(null); alert(r.ipChanged ? "บันทึกแล้ว IP เปลี่ยน กำลังค้นหาการเชื่อมต่อใหม่" : "บันทึกกลับไปที่ทะเบียนแล้ว"); },
    onError: (e) => alert((e as Error).message),
  });
  const loadRepairs = useMutation({ mutationFn: () => api<Repair[]>(`/api/registry/cameras/${cameraId}/repairs`), onSuccess: (r) => setRepairs(Array.isArray(r) ? r : []) });

  const Row = ({ label, value }: { label: string; value: unknown }) => (
    <div className="flex justify-between gap-4 border-b border-ink-800/70 py-1.5 text-sm"><span className="text-zinc-500">{label}</span><span className="text-right text-zinc-200">{value as string}</span></div>
  );

  return (
    <Modal title={`ทะเบียนอุปกรณ์ · ${deviceNo}`} onClose={onClose} wide>
      {reg.isLoading && <div className="text-sm text-zinc-500">กำลังโหลด…</div>}
      {reg.data && !reg.data.linked && <div className="text-sm text-amber-400">กล้องนี้ยังไม่ผูกกับทะเบียน (ยังไม่มี registryId) ลองกดซิงก์ทะเบียน</div>}
      {reg.data?.linked && !edit && (
        <div>
          <div className="grid gap-x-8 md:grid-cols-2">
            <Row label="รหัสอุปกรณ์" value={s(dd.DeviceNo)} />
            <Row label="Registry ID" value={s(reg.data.registryId)} />
            <Row label="IP หลัก" value={s(dd.IPv4_1)} />
            <Row label="IP รอง" value={s(dd.IPv4_2)} />
            <Row label="ชั้น / ห้อง" value={`${s(dd.FloorCode)} / ${s(dd.RoomCode)}`} />
            <Row label="สถานะ (Status1)" value={String(dd.Status1) === "1" ? "เลิกใช้งาน" : "ใช้งาน"} />
            <Row label="วันที่ซื้อ" value={d(dd.PurchaseDate)} />
            <Row label="หมดประกัน" value={d(dd.OutWarranty)} />
            <Row label="ผู้ถือครอง" value={s(dd.Owner)} />
            <Row label="บัญชีเข้าระบบ" value={`${reg.data.detail?.UserLogin?.length ?? 0} บัญชี`} />
          </div>
          <div className="mt-2"><div className="text-xs text-zinc-500">รายละเอียด / OSD</div><div className="text-sm text-zinc-200">{s(dd.Desciption)}</div></div>

          <div className="mt-4 flex items-center gap-2">
            <Button variant="ghost" onClick={() => loadRepairs.mutate()} disabled={loadRepairs.isPending}><Wrench size={14} /> ประวัติแจ้งซ่อม</Button>
            {can("OPERATOR") && <Button variant="gold" onClick={() => setEdit({ IPv4_1: s(dd.IPv4_1) === "-" ? "" : String(dd.IPv4_1), Desciption: s(dd.Desciption) === "-" ? "" : String(dd.Desciption), Status1: String(dd.Status1 ?? "0") })}>แก้ไขทะเบียน</Button>}
          </div>
          {repairs && (
            <div className="mt-3">
              <div className="mb-1.5 text-xs font-medium text-zinc-400">ประวัติแจ้งซ่อม {repairs.length > 0 && `(${repairs.length})`}</div>
              {repairs.length === 0 ? (
                <div className="rounded-lg border border-ink-800 p-3 text-xs text-zinc-600">ไม่มีประวัติแจ้งซ่อม</div>
              ) : (
                <div className="max-h-60 space-y-2 overflow-auto pr-1">
                  {repairs.map((r, i) => {
                    const done = /เสร็จ|สำเร็จ|ปิด/.test(r.StatusName ?? "");
                    return (
                      <div key={i} className="rounded-lg border border-ink-800 bg-ink-850 p-3 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-zinc-300">{s(r.BillDoc)}</span>
                          <span className={clsx("rounded px-1.5 py-0.5 text-[10px]", done ? "bg-emerald-900/50 text-emerald-300" : "bg-amber-900/50 text-amber-200")}>{s(r.StatusName)}</span>
                        </div>
                        <div className="mt-1.5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                          <div><span className="text-zinc-500">แจ้งเมื่อ </span><span className="text-zinc-300">{dt(r.JobDate)}</span></div>
                          <div><span className="text-zinc-500">เสร็จเมื่อ </span><span className="text-zinc-300">{dt(r.FinishDate)}</span></div>
                        </div>
                        {r.BrokenDes && <div className="mt-1.5"><span className="text-zinc-500">อาการ: </span><span className="text-zinc-200">{r.BrokenDes}</span></div>}
                        {r.RepairDes && <div><span className="text-zinc-500">การซ่อม: </span><span className="text-zinc-200">{r.RepairDes}</span></div>}
                        <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
                          <span>ผู้แจ้ง: {s(r.EmpFullName)}</span>
                          {((r.RepairPrice ?? 0) + (r.PartPrice ?? 0)) > 0 && <span>ค่าใช้จ่าย {(((r.RepairPrice ?? 0) + (r.PartPrice ?? 0))).toLocaleString("th-TH")} บาท</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {edit && (
        <div className="space-y-3">
          <p className="text-xs text-amber-400/80">แก้ไขนี้จะเขียนกลับไปที่ทะเบียนอุปกรณ์ (webae) โดยตรง</p>
          <Field label="IP หลัก"><Input value={edit.IPv4_1} onChange={(e) => setEdit({ ...edit, IPv4_1: e.target.value })} /></Field>
          <Field label="รายละเอียด / OSD"><Input value={edit.Desciption} onChange={(e) => setEdit({ ...edit, Desciption: e.target.value })} /></Field>
          <Field label="สถานะ"><Select value={edit.Status1} onChange={(e) => setEdit({ ...edit, Status1: e.target.value })}><option value="0">ใช้งาน</option><option value="1">เลิกใช้งาน</option></Select></Field>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setEdit(null)}>ยกเลิก</Button><Button variant="gold" disabled={save.isPending} onClick={() => save.mutate(edit)}>บันทึกกลับทะเบียน</Button></div>
        </div>
      )}
      <div className="mt-4 text-right text-[11px] text-zinc-600"><ExternalLink size={10} className="mr-1 inline" />ข้อมูลสดจากระบบทะเบียนอุปกรณ์ webae · ซิงก์อัตโนมัติทุก 5 นาที</div>
    </Modal>
  );
}
