/**
 * Plays a go2rtc stream using go2rtc's own <video-stream> web component, loaded from the
 * go2rtc server so the player always matches the running go2rtc version. The component
 * handles MSE/WebRTC negotiation, reconnects, and pauses when scrolled out of view.
 *
 * - `controls` shows the native seek/transport bar (use it for playback). In live view it is
 *   hidden so the useless live scrubber doesn't appear on hover.
 * - `zoom` adds digital zoom/pan for normal lenses (fisheye cameras use their own free-look view).
 * - Audio starts muted (browsers require it for autoplay); the speaker button unmutes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Orbit, Volume2, VolumeX } from "lucide-react";
import clsx from "clsx";
import { FisheyeView, parseFisheye } from "./FisheyeView";
import { ZoomPan } from "./ZoomPan";

const loaded = new Map<string, Promise<void>>();

function ensureScript(go2rtcUrl: string): Promise<void> {
  if (customElements.get("video-stream")) return Promise.resolve();
  let p = loaded.get(go2rtcUrl);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.type = "module";
      s.src = `${go2rtcUrl}/video-stream.js`;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`cannot load ${s.src}`));
      document.head.appendChild(s);
    });
    loaded.set(go2rtcUrl, p);
  }
  return p;
}

export function wsUrl(go2rtcUrl: string, stream: string) {
  const u = new URL(go2rtcUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/api/ws";
  u.search = `?src=${encodeURIComponent(stream)}`;
  return u.toString();
}

export function LivePlayer({ go2rtcUrl, stream, mode = "mse,webrtc", className, controls = false, audio = true, fisheye, zoom = false }: { go2rtcUrl: string; stream: string; mode?: string; className?: string; controls?: boolean; audio?: boolean; fisheye?: string | null; zoom?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLElement | null>(null);
  const [muted, setMuted] = useState(true);
  const cal = parseFisheye(fisheye);
  const [dewarp, setDewarp] = useState(true);
  const getVideo = useCallback(() => (elRef.current as unknown as { video?: HTMLVideoElement } | null)?.video, []);

  useEffect(() => {
    let cancelled = false;
    let el: HTMLElement | null = null;
    ensureScript(go2rtcUrl)
      .then(() => {
        if (cancelled || !ref.current) return;
        el = document.createElement("video-stream");
        (el as unknown as { mode: string }).mode = mode;
        (el as unknown as { background: boolean }).background = false;
        (el as unknown as { src: string }).src = wsUrl(go2rtcUrl, stream);
        ref.current.replaceChildren(el);
        elRef.current = el;
        // Enforce muted-by-default and the chosen controls mode once the inner <video> exists.
        const apply = () => {
          const v = (el as unknown as { video?: HTMLVideoElement }).video;
          if (v) { v.muted = true; v.controls = controls; }
        };
        apply();
        setTimeout(apply, 300);
      })
      .catch((e) => {
        if (ref.current) ref.current.textContent = (e as Error).message;
      });
    return () => {
      cancelled = true;
      if (el) {
        (el as unknown as { src: string }).src = "";
        el.remove();
      }
      elRef.current = null;
    };
  }, [go2rtcUrl, stream, mode, controls]);

  function toggleMute(e: React.MouseEvent) {
    e.stopPropagation();
    const v = (elRef.current as unknown as { video?: HTMLVideoElement } | null)?.video;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted) v.volume = 1;
    setMuted(v.muted);
  }

  return (
    <div className={clsx("group relative", className ?? "h-full w-full bg-black", !controls && "lp-hidecontrols")}>
      {zoom && !cal
        ? <ZoomPan><div ref={ref} className="h-full w-full" /></ZoomPan>
        : <div ref={ref} className={clsx("h-full w-full", cal && dewarp && "invisible")} />}
      {cal && dewarp && <div className="absolute inset-0"><FisheyeView getVideo={getVideo} cal={cal} /></div>}
      {cal && (
        <button onClick={(e) => { e.stopPropagation(); setDewarp((d) => !d); }} className="absolute right-1 top-1 z-10 flex items-center gap-1 rounded bg-black/60 px-1.5 py-1 text-xs text-zinc-300 hover:text-gold-300" title={dewarp ? "ดูภาพวงกลมเต็ม (fisheye)" : "หมุนดูภาพอิสระ"}>
          <Orbit size={14} /> {dewarp ? "ภาพเต็มวง" : "หมุนดูภาพ"}
        </button>
      )}
      {audio && !controls && (
        <button onClick={toggleMute} className="absolute bottom-1 left-1 z-10 rounded bg-black/60 p-1 text-zinc-300 opacity-0 transition hover:text-gold-300 group-hover:opacity-100" title={muted ? "เปิดเสียง" : "ปิดเสียง"}>
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
      )}
    </div>
  );
}
