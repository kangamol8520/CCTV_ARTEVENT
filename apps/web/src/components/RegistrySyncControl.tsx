import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Select } from "./ui";

interface SyncStatus {
  configured: boolean; intervalSec: number; running: boolean;
  lastRunAt: string | null; lastOk: boolean | null; lastError: string | null; nextRunAt: string | null;
  lastSummary: { updated?: number; created?: number; portsChanged?: string[]; errors?: string[] } | null;
}

/** Choices in minutes; 0 = off. Anything else set via the API is shown as its own option. */
const CHOICES = [0, 1, 5, 10, 15, 30, 60, 120, 360, 720, 1440];
const label = (min: number) => (min === 0 ? "ปิดซิงก์อัตโนมัติ" : min < 60 ? `ทุก ${min} นาที` : min % 60 === 0 ? `ทุก ${min / 60} ชั่วโมง` : `ทุก ${min} นาที`);
const time = (s: string | null) => (s ? new Date(s).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "-");

/** Registry auto-sync: shows the schedule, lets ADMIN change the interval and OPERATOR sync now. */
export function RegistrySyncControl() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const st = useQuery({ queryKey: ["registry-sync"], queryFn: () => api<SyncStatus>("/api/registry/sync-settings"), refetchInterval: 15000 });
  const saveInterval = useMutation({
    mutationFn: (intervalSec: number) => api<SyncStatus>("/api/registry/sync-settings", { method: "PUT", json: { intervalSec } }),
    onSuccess: (r) => qc.setQueryData(["registry-sync"], r),
    onError: (e) => alert((e as Error).message),
  });
  const syncNow = useMutation({
    mutationFn: () => api<{ updated: number; created: number; portsChanged: string[]; errors: string[] }>("/api/registry/sync", { method: "POST" }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["registry-sync"] });
      qc.invalidateQueries({ queryKey: ["cameras"] });
      const changed = r.portsChanged.length ? `\nเปลี่ยนพอร์ต/โปรโตคอล ${r.portsChanged.length} รายการ:\n${r.portsChanged.slice(0, 10).join("\n")}` : "";
      alert(`ซิงก์ทะเบียนแล้ว: อัปเดต ${r.updated} · เพิ่มใหม่ ${r.created}${r.errors.length ? ` · ผิดพลาด ${r.errors.length}` : ""}${changed}`);
    },
    onError: (e) => alert((e as Error).message),
  });

  const s = st.data;
  if (!s?.configured) return null;
  const min = Math.round(s.intervalSec / 60);
  const opts = CHOICES.includes(min) ? CHOICES : [...CHOICES, min].sort((a, b) => a - b);
  const busy = s.running || syncNow.isPending;

  return (
    <div className="flex items-center gap-2 text-xs text-zinc-400">
      <span className="hidden lg:inline">ซิงก์ทะเบียน</span>
      {can("ADMIN") ? (
        <Select className="w-40 py-1 text-xs" value={min} disabled={saveInterval.isPending} onChange={(e) => saveInterval.mutate(Number(e.target.value) * 60)} title="ความถี่ในการดึงข้อมูลจากระบบทะเบียน">
          {opts.map((m) => <option key={m} value={m}>{label(m)}</option>)}
        </Select>
      ) : (
        <span className="text-zinc-300">{label(min)}</span>
      )}
      <span className="hidden whitespace-nowrap md:inline" title={s.lastError ?? undefined}>
        ล่าสุด {time(s.lastRunAt)}{s.lastOk === false && <span className="text-red-400"> (ผิดพลาด)</span>}
        {s.nextRunAt && <> · ถัดไป {time(s.nextRunAt)}</>}
      </span>
      {can("OPERATOR") && (
        <Button variant="ghost" onClick={() => syncNow.mutate()} disabled={busy} title="ดึงข้อมูลจากทะเบียนเดี๋ยวนี้">
          <RefreshCw size={14} className={busy ? "animate-spin" : undefined} /> {busy ? "กำลังซิงก์…" : "ซิงก์ตอนนี้"}
        </Button>
      )}
    </div>
  );
}
