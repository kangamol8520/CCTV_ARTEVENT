import clsx from "clsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export const Button = ({ className, variant = "primary", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "gold" }) => (
  <button
    className={clsx(
      "inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors disabled:opacity-40",
      variant === "primary" && "bg-ink-800 text-cream ring-1 ring-ink-700 hover:bg-ink-750 hover:ring-gold-700",
      variant === "gold" && "bg-gradient-to-b from-gold-400 to-gold-600 text-ink-950 font-semibold hover:from-gold-300 hover:to-gold-500 shadow-sm shadow-gold-700/30",
      variant === "ghost" && "text-zinc-300 hover:bg-ink-800 hover:text-cream",
      variant === "danger" && "bg-red-900/70 text-red-100 ring-1 ring-red-800/60 hover:bg-red-800",
      className,
    )}
    {...p}
  />
);

const fieldCls = "w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-cream outline-none transition-colors placeholder:text-zinc-600 focus:border-gold-500 focus:ring-1 focus:ring-gold-600/40";
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={clsx(fieldCls, className)} {...p} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={clsx(fieldCls, "appearance-none", className)} {...p} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={clsx(fieldCls, className)} {...p} />;

export const Field = ({ label, children, className }: { label: string; children: ReactNode; className?: string }) => (
  <label className={clsx("block text-xs text-zinc-400", className)}>
    <span className="mb-1 block font-medium tracking-wide">{label}</span>
    {children}
  </label>
);

export const StatusDot = ({ status }: { status: string }) => (
  <span className={clsx("inline-block h-2 w-2 rounded-full", status === "ONLINE" ? "bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/70" : status === "OFFLINE" ? "bg-red-500" : "bg-zinc-600")} title={status} />
);

export const PageHeader = ({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) => (
  <div className="flex items-center justify-between border-b border-ink-800 bg-ink-900/40 px-6 py-3.5">
    <div>
      <h1 className="font-display text-lg font-semibold tracking-tight text-cream">{title}</h1>
      {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
    </div>
    <div className="flex items-center gap-2">{children}</div>
  </div>
);

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className={clsx("max-h-full w-full overflow-auto rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")} onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 font-display text-base font-semibold text-cream">{title}</div>
        {children}
      </div>
    </div>
  );
}

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={clsx("rounded-xl border border-ink-800 bg-ink-900", className)}>{children}</div>
);

export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("th-TH", { hour12: false }) : "-");
export const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
