/**
 * Digital zoom for a normal (non-fisheye) camera picture.
 * Wheel / trackpad pinch / two-finger pinch = zoom around the pointer, drag = pan while zoomed,
 * double-click = back to 1×. The picture never leaves the frame (pan is clamped).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";

const MAX = 8;

export function ZoomPan({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const v = useRef({ s: 1, x: 0, y: 0 });
  const [scale, setScale] = useState(1);

  const apply = () => {
    const el = box.current, cv = inner.current;
    if (!el || !cv) return;
    const { clientWidth: w, clientHeight: h } = el;
    const t = v.current;
    t.s = Math.max(1, Math.min(MAX, t.s));
    // keep the scaled picture covering the frame
    t.x = Math.min(0, Math.max(w - w * t.s, t.x));
    t.y = Math.min(0, Math.max(h - h * t.s, t.y));
    cv.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})`;
    setScale(t.s);
  };

  /** zoom by factor f keeping the point (px,py) (relative to the frame) fixed */
  const zoomAt = (f: number, px: number, py: number) => {
    const t = v.current;
    const ns = Math.max(1, Math.min(MAX, t.s * f));
    const k = ns / t.s;
    t.x = px - (px - t.x) * k;
    t.y = py - (py - t.y) * k;
    t.s = ns;
    apply();
  };
  const zoomCenter = (f: number) => {
    const el = box.current;
    if (el) zoomAt(f, el.clientWidth / 2, el.clientHeight / 2);
  };
  const reset = () => { v.current = { s: 1, x: 0, y: 0 }; apply(); };
  const resetRef = useRef(reset);
  resetRef.current = reset;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch: { d: number } | null = null;
    const rel = (e: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      // trackpad pinch arrives as ctrl+wheel with small deltas → stronger factor
      const k = e.ctrlKey ? 0.01 : 0.0015;
      const p = rel(e);
      zoomAt(Math.exp(-e.deltaY * k), p.x, p.y);
    };
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) }; }
    };
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const c = rel({ clientX: (a!.x + b!.x) / 2, clientY: (a!.y + b!.y) / 2 });
        if (pinch.d > 0) zoomAt(d / pinch.d, c.x, c.y);
        pinch.d = d;
      } else if (v.current.s > 1) {
        v.current.x += e.clientX - prev.x;
        v.current.y += e.clientY - prev.y;
        apply();
      }
    };
    const up = (e: PointerEvent) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
    const dbl = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("button")) resetRef.current(); };
    const resize = new ResizeObserver(() => apply());
    resize.observe(el);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("dblclick", dbl);
    return () => {
      resize.disconnect();
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("dblclick", dbl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={box}
      className={`relative h-full w-full touch-none overflow-hidden ${scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
      title="เลื่อนลูกกลิ้ง/หุบ-กางนิ้วเพื่อซูม · ลากเพื่อเลื่อนภาพ · ดับเบิลคลิกเพื่อกลับขนาดเดิม"
    >
      <div ref={inner} className="h-full w-full origin-top-left will-change-transform">{children}</div>
      <div className="absolute bottom-1 right-1 z-10 flex items-center gap-0.5 rounded bg-black/60 p-0.5 text-xs text-zinc-300">
        <button onClick={(e) => { e.stopPropagation(); zoomCenter(1 / 1.5); }} disabled={scale <= 1} className="rounded p-1 hover:text-gold-300 disabled:opacity-40" title="ซูมออก"><Minus size={14} /></button>
        <button onClick={(e) => { e.stopPropagation(); reset(); }} className="min-w-9 rounded px-1 tabular-nums hover:text-gold-300" title="กลับขนาดเดิม">{scale.toFixed(1)}×</button>
        <button onClick={(e) => { e.stopPropagation(); zoomCenter(1.5); }} disabled={scale >= MAX} className="rounded p-1 hover:text-gold-300 disabled:opacity-40" title="ซูมเข้า"><Plus size={14} /></button>
      </div>
    </div>
  );
}
