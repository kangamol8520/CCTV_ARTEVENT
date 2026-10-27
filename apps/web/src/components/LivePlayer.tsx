/**
 * Plays a go2rtc stream using go2rtc's own <video-stream> web component, loaded from the
 * go2rtc server so the player always matches the running go2rtc version. The component
 * handles MSE/WebRTC negotiation, reconnects, and pauses when scrolled out of view.
 */
import { useEffect, useRef } from "react";

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

export function LivePlayer({ go2rtcUrl, stream, mode = "mse,webrtc", className }: { go2rtcUrl: string; stream: string; mode?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let el: HTMLElement | null = null;
    ensureScript(go2rtcUrl)
      .then(() => {
        if (cancelled || !ref.current) return;
        el = document.createElement("video-stream");
        (el as unknown as { mode: string }).mode = mode;
        (el as unknown as { src: string }).src = wsUrl(go2rtcUrl, stream);
        ref.current.replaceChildren(el);
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
    };
  }, [go2rtcUrl, stream, mode]);

  return <div ref={ref} className={className ?? "h-full w-full bg-black"} />;
}
