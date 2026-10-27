import { NavLink, Outlet } from "react-router-dom";
import { Activity, Camera, FolderKanban, HardDrive, History, LayoutDashboard, LayoutGrid, LogOut, Video } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../lib/auth";

const nav = [
  { to: "/", label: "ภาพรวม", icon: LayoutDashboard, end: true },
  { to: "/live", label: "ดูสด", icon: Video },
  { to: "/layouts", label: "จัดเลย์เอาต์", icon: LayoutGrid },
  { to: "/playback", label: "ดูย้อนหลัง", icon: History },
  { to: "/events", label: "เหตุการณ์", icon: Activity },
  { to: "/cameras", label: "กล้อง", icon: Camera },
  { to: "/groups", label: "กลุ่มกล้อง", icon: FolderKanban },
  { to: "/nvrs", label: "เครื่องบันทึก", icon: HardDrive },
];

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="flex h-full bg-ink-950">
      <aside className="flex w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-b from-gold-300 to-gold-600 font-display text-sm font-bold text-ink-950">AE</span>
          <div className="leading-tight">
            <div className="font-display text-[15px] font-semibold tracking-wide text-gradient-gold">ARTEVENT</div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">CCTV Center</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => clsx(
              "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              isActive ? "bg-ink-800 text-cream ring-1 ring-gold-700/50" : "text-zinc-400 hover:bg-ink-850 hover:text-zinc-100",
            )}>
              {({ isActive }) => (<>
                <n.icon size={17} className={isActive ? "text-gold-400" : "text-zinc-500 group-hover:text-zinc-300"} />
                <span className="font-medium">{n.label}</span>
              </>)}
            </NavLink>
          ))}
        </nav>
        <div className="m-3 rounded-xl border border-ink-800 bg-ink-850 px-4 py-3 text-xs">
          <div className="truncate font-medium text-cream">{user?.displayName}</div>
          <div className="mt-0.5 flex items-center justify-between text-zinc-500">
            <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-gold-400">{user?.role}</span>
            <button onClick={logout} className="flex items-center gap-1 hover:text-cream"><LogOut size={12} /> ออก</button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
