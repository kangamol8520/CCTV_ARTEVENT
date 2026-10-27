import { NavLink, Outlet } from "react-router-dom";
import { Activity, Camera, FolderKanban, HardDrive, History, LayoutDashboard, LogOut, Video } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../lib/auth";

const nav = [
  { to: "/", label: "ภาพรวม", icon: LayoutDashboard, end: true },
  { to: "/live", label: "Live", icon: Video },
  { to: "/playback", label: "ย้อนหลัง", icon: History },
  { to: "/events", label: "เหตุการณ์", icon: Activity },
  { to: "/cameras", label: "กล้อง", icon: Camera },
  { to: "/groups", label: "กลุ่มกล้อง", icon: FolderKanban },
  { to: "/nvrs", label: "NVR", icon: HardDrive },
];

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="px-4 py-4 text-lg font-semibold tracking-tight">CCTV Platform</div>
        <nav className="flex-1 space-y-0.5 px-2">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => clsx("flex items-center gap-2 rounded-md px-3 py-2 text-sm", isActive ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100")}>
              <n.icon size={16} /> {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-400">
          <div className="truncate text-zinc-200">{user?.displayName}</div>
          <div className="flex items-center justify-between">
            <span>{user?.role}</span>
            <button onClick={logout} className="flex items-center gap-1 hover:text-white"><LogOut size={12} /> ออก</button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
