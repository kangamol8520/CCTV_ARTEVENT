/**
 * File a repair ticket (ใบแจ้งซ่อม) in webae for one camera. Floor/room/device come from the
 * registry on the server; the user supplies what the registry doesn't have: reporter, phone,
 * what is wrong (any request — broken, blurry, moved, relocate, reconfigure — not only "offline").
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "../lib/api";
import { Button, Field, Input, Textarea, toLocalInput } from "./ui";

interface Repair { BillDoc?: string; StatusName?: string; Status?: string; JobDate?: string; BrokenDes?: string }

const PRESETS = [
  "กล้องไม่ติด / ภาพไม่ขึ้น",
  "ภาพมัว ไม่ชัด",
  "มุมกล้องเลื่อน / ภาพเอียง",
  "กลางคืนภาพมืด (IR ไม่ทำงาน)",
  "ภาพกระตุก / หลุดเป็นช่วง",
  "ขอย้ายหรือปรับตำแหน่งกล้อง",
  "ขอตั้งค่ากล้อง / เปลี่ยนรหัสผ่าน",
  "ไม่บันทึกลง NVR",
];

export function RepairForm({ cameraId, deviceNo, floorRoom, repairs, onDone, onCancel }: {
  cameraId: number; deviceNo: string; floorRoom: string; repairs: Repair[];
  onDone: (billDoc: string | null) => void; onCancel: () => void;
}) {
  const qc = useQueryClient();
  const defaults = useQuery({ queryKey: ["repair-defaults"], queryFn: () => api<{ contactPerson: string; tel: string; maxBrokenDes: number }>("/api/registry/repair-defaults"), staleTime: Infinity });
  const max = defaults.data?.maxBrokenDes ?? 190;
  const [contact, setContact] = useState("");
  const [tel, setTel] = useState("");
  const [des, setDes] = useState("");
  const [day, setDay] = useState(toLocalInput(new Date()).slice(0, 10));
  const [force, setForce] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (defaults.data) { setContact((c) => c || defaults.data.contactPerson); setTel((t) => t || defaults.data.tel); }
  }, [defaults.data]);

  // Reporter name lookup (debounced)
  const [code, setCode] = useState("");
  useEffect(() => { const t = setTimeout(() => setCode(contact.trim()), 350); return () => clearTimeout(t); }, [contact]);
  const emp = useQuery({
    queryKey: ["registry-employee", code],
    queryFn: () => api<{ code: string; name: string | null }>(`/api/registry/employees/${encodeURIComponent(code)}`),
    enabled: code.length >= 3,
  });

  const open = repairs.filter((r) => r.Status ? r.Status !== "3" : !/เสร็จ|สำเร็จ|ปิด/.test(r.StatusName ?? ""));
  const addPreset = (p: string) => setDes((cur) => (cur.includes(p) ? cur : (cur.trim() ? `${cur.trim()} · ${p}` : p)).slice(0, max));

  const submit = useMutation({
    mutationFn: () => api<{ billDoc: string | null; billId: number | null }>(`/api/registry/cameras/${cameraId}/repairs`, {
      method: "POST",
      json: { contactPerson: contact.trim(), tel: tel.trim(), brokenDes: des.trim(), dueDate: day, force: open.length > 0 ? force : undefined },
    }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["registry-repairs", cameraId] }); onDone(r.billDoc); },
    onError: (e) => setErr((e as Error).message),
  });

  const nameOk = emp.data?.name;
  const canSubmit = contact.trim() && des.trim() && des.length <= max && (open.length === 0 || force) && !submit.isPending && (code.length < 3 || emp.isLoading || !!nameOk);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-ink-800 bg-ink-850 p-2.5 text-xs text-zinc-400">
        แจ้งซ่อม <span className="font-mono text-cream">{deviceNo}</span> · ชั้น/ห้อง {floorRoom} · หมวด กล้องวงจรปิด (A003)
        <div className="text-[11px] text-zinc-500">ใบงานจะถูกสร้างในระบบแจ้งซ่อม webae ทันทีเมื่อกดส่ง</div>
      </div>

      {open.length > 0 && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-900/15 p-2.5 text-xs text-amber-200">
          มีใบแจ้งซ่อมที่ยังไม่เสร็จ: {open.map((r) => `${r.BillDoc} (${r.StatusName ?? r.Status}) ${r.BrokenDes ? `“${r.BrokenDes.slice(0, 40)}”` : ""}`).join(", ")}
          <label className="mt-1.5 flex items-center gap-1.5 text-amber-100">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> เป็นเรื่องใหม่ ต้องการแจ้งเพิ่มอีกใบ
          </label>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="รหัสพนักงานผู้แจ้ง *">
          <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="เช่น 1372" />
          <div className={clsx("mt-0.5 h-4 truncate text-[11px]", nameOk ? "text-emerald-400" : "text-red-400")}>
            {code.length >= 3 && !emp.isLoading && (nameOk ?? "ไม่พบรหัสนี้ / พ้นสภาพแล้ว")}
          </div>
        </Field>
        <Field label="เบอร์โทรติดต่อ"><Input value={tel} onChange={(e) => setTel(e.target.value)} placeholder="เบอร์ภายใน / มือถือ" /></Field>
        <Field label="วันที่แจ้ง"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium text-zinc-400">อาการเสีย / สิ่งที่ต้องการ *</div>
        <div className="mb-1.5 flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button key={p} type="button" onClick={() => addPreset(p)}
              className={clsx("rounded-full px-2 py-0.5 text-[11px] ring-1", des.includes(p) ? "bg-gold-600/20 text-gold-300 ring-gold-700" : "text-zinc-400 ring-ink-700 hover:text-cream")}>{p}</button>
          ))}
        </div>
        <Textarea rows={3} value={des} onChange={(e) => setDes(e.target.value)} placeholder="อธิบายอาการ หรือสิ่งที่ต้องการให้ช่างทำ เช่น ภาพมัวตั้งแต่เมื่อวาน / ขอย้ายกล้องไปมุมประตู" />
        <div className={clsx("text-right text-[11px]", des.length > max ? "text-red-400" : "text-zinc-500")}>{des.length}/{max}</div>
      </div>

      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>ยกเลิก</Button>
        <Button variant="gold" disabled={!canSubmit} onClick={() => { setErr(null); submit.mutate(); }}>{submit.isPending ? "กำลังส่ง…" : "ส่งใบแจ้งซ่อม"}</Button>
      </div>
    </div>
  );
}
