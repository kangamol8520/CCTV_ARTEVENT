import { useEffect, useRef, useState } from "react";
import { Video, VideoOff } from "lucide-react";
import clsx from "clsx";

/**
 * A lightweight snapshot of a camera's current view, fetched from go2rtc's single-frame
 * endpoint only once the thumbnail scrolls into view (so a long list costs little).
 */
export function CameraThumb({ go2rtcUrl, stream, status, className, refreshable }: { go2rtcUrl: string; stream: string; status?: string; className?: string; refreshable?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const [err, setErr] = useState(false);
  const [bust, setBust] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0]!.isIntersecting) { setShow(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const offline = status === "OFFLINE";
  const src = `${go2rtcUrl}/api/frame.jpeg?src=${encodeURIComponent(stream)}${bust ? `&_=${bust}` : ""}`;
  return (
    <div ref={ref} className={clsx("relative overflow-hidden bg-black", className)}>
      {show && !err && !offline ? (
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" onError={() => setErr(true)} />
      ) : (
        <div className="grid h-full w-full place-items-center text-ink-600">
          {offline ? <VideoOff size={18} /> : <Video size={18} className="opacity-40" />}
        </div>
      )}
      {refreshable && show && !offline && (
        <button onClick={(e) => { e.stopPropagation(); setErr(false); setBust(Date.now()); }} className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-zinc-300 opacity-0 hover:text-cream group-hover:opacity-100">รีเฟรช</button>
      )}
    </div>
  );
}
