import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Event, SystemStatus } from "../types";
import { PageHeader, fmtDate } from "../components/ui";
import { Link } from "react-router-dom";

const Stat = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
  <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
    <div className="text-xs text-zinc-400">{label}</div>
    <div className="mt-1 text-2xl font-semibold">{value}</div>
    {sub && <div className="text-xs text-zinc-500">{sub}</div>}
  </div>
);

export function Dashboard() {
  const status = useQuery({ queryKey: ["system-status"], queryFn: () => api<SystemStatus>("/api/system/status"), refetchInterval: 15000 });
  const events = useQuery({ queryKey: ["events", "recent"], queryFn: () => api<{ items: Event[] }>("/api/events?pageSize=10"), refetchInterval: 30000 });
  const s = status.data;
  return (
    <div>
      <PageHeader title="ภาพรวมระบบ" />
      <div className="grid grid-cols-2 gap-3 p-5 md:grid-cols-4">
        <Stat label="กล้องออนไลน์" value={s ? `${s.cameras.online} / ${s.cameras.total}` : "…"} sub="เฉพาะกล้องที่เปิดใช้งาน" />
        <Stat label="NVR ออนไลน์" value={s ? `${s.nvrs.online} / ${s.nvrs.total}` : "…"} />
        <Stat label="สตรีมที่กำลังดึง" value={s ? s.go2rtc.activeStreams : "…"} sub={s ? (s.go2rtc.reachable ? "go2rtc เชื่อมต่อแล้ว" : "go2rtc ไม่ตอบสนอง") : undefined} />
        <Stat label="ผู้ชมขณะนี้" value={s ? s.go2rtc.viewers : "…"} />
      </div>
      <div className="px-5 pb-5">
        <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-zinc-300">เหตุการณ์ล่าสุด</h2><Link to="/events" className="text-xs text-gold-400 hover:underline">ดูทั้งหมด</Link></div>
        <div className="divide-y divide-ink-800 rounded-lg border border-ink-800 bg-ink-900">
          {events.data?.items.length === 0 && <div className="p-4 text-sm text-zinc-500">ยังไม่มีเหตุการณ์</div>}
          {events.data?.items.map((e) => (
            <div key={e.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className={`rounded px-1.5 py-0.5 text-xs ${e.severity === "CRITICAL" || e.severity === "HIGH" ? "bg-red-900/60 text-red-200" : "bg-ink-800 text-zinc-300"}`}>{e.severity}</span>
              <span className="flex-1 truncate">{e.title}</span>
              <span className="text-zinc-400">{e.camera?.deviceNo ?? "-"}</span>
              <span className="text-xs text-zinc-500">{fmtDate(e.startedAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
