import clsx from "clsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export const Button = ({ className, variant = "primary", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) => (
  <button
    className={clsx(
      "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50",
      variant === "primary" && "bg-blue-600 text-white hover:bg-blue-500",
      variant === "ghost" && "border border-zinc-700 text-zinc-200 hover:bg-zinc-800",
      variant === "danger" && "bg-red-600/80 text-white hover:bg-red-500",
      className,
    )}
    {...p}
  />
);

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={clsx("w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500", className)} {...p} />
);
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={clsx("w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500", className)} {...p} />
);
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={clsx("w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500", className)} {...p} />
);

export const Field = ({ label, children, className }: { label: string; children: ReactNode; className?: string }) => (
  <label className={clsx("block text-xs text-zinc-400", className)}>
    <span className="mb-1 block">{label}</span>
    {children}
  </label>
);

export const StatusDot = ({ status }: { status: string }) => (
  <span className={clsx("inline-block h-2 w-2 rounded-full", status === "ONLINE" ? "bg-emerald-500" : status === "OFFLINE" ? "bg-red-500" : "bg-zinc-500")} title={status} />
);

export const PageHeader = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
    <h1 className="text-base font-semibold">{title}</h1>
    <div className="flex items-center gap-2">{children}</div>
  </div>
);

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className={clsx("max-h-full w-full overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl", wide ? "max-w-3xl" : "max-w-lg")} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 text-base font-semibold">{title}</div>
        {children}
      </div>
    </div>
  );
}

export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("th-TH", { hour12: false }) : "-");
export const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
