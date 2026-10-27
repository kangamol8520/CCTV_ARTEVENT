import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Renders `children` only while the element is in (or near) the viewport, otherwise `placeholder`.
 * Used so a large camera wall only opens live streams for the tiles actually on screen —
 * the rest stay as a cheap placeholder and pull no network traffic.
 */
export function LazyVisible({ children, placeholder, className, rootMargin = "350px" }: { children: ReactNode; placeholder?: ReactNode; className?: string; rootMargin?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setVisible(entries[0]!.isIntersecting), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);
  return (
    <div ref={ref} className={className}>
      {visible ? children : placeholder}
    </div>
  );
}
