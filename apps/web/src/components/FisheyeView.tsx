/**
 * Free-look viewer for a ceiling-mounted fisheye camera. The camera (and the recordings) keep the raw
 * circular image; this component dewarps it in the browser with WebGL, so looking around costs no
 * server CPU and works the same for live video and recorded files.
 *
 * Drag = look around (pan / tilt), wheel = zoom, double-click = reset.
 * Lens model: equidistant fisheye (image radius ∝ angle from the lens axis), the usual for
 * CCTV fisheyes; calibration "cx,cy,r,fov" comes from Camera.fisheye.
 */
import { useEffect, useRef } from "react";

export interface FisheyeCal { cx: number; cy: number; r: number; fov: number }

/** "cx,cy,r,fov" → calibration, or null when the camera has a normal lens. */
export function parseFisheye(s?: string | null): FisheyeCal | null {
  if (!s) return null;
  const [cx, cy, r, fov] = s.split(",").map(Number);
  if (![cx, cy, r, fov].every((n) => Number.isFinite(n)) || !r || !fov) return null;
  return { cx: cx!, cy: cy!, r: r!, fov: fov! };
}

const VS = `attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `precision highp float;
varying vec2 v;
uniform sampler2D tex;
uniform float yaw, pitch, tanHalf, aspect, cx, cy, rad, thetaMax, texW, texH;
void main() {
  // view ray: x right, y down the screen, z forward
  vec3 d = normalize(vec3(v.x * tanHalf * aspect, -v.y * tanHalf, 1.0));
  // tilt away from the lens axis, then turn around it
  float cp = cos(pitch), sp = sin(pitch);
  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float cw = cos(yaw), sw = sin(yaw);
  d = vec3(d.x * cw - d.y * sw, d.x * sw + d.y * cw, d.z);
  float theta = acos(clamp(d.z, -1.0, 1.0));
  if (theta > thetaMax) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float phi = atan(d.y, d.x);
  float rr = theta / thetaMax * rad;
  gl_FragColor = texture2D(tex, vec2((cx + rr * cos(phi)) / texW, (cy + rr * sin(phi)) / texH));
}`;

const DEFAULT = { yaw: 0, pitch: (50 * Math.PI) / 180, fov: 80 };

export function FisheyeView({ getVideo, cal, className }: { getVideo: () => HTMLVideoElement | null | undefined; cal: FisheyeCal; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ ...DEFAULT });

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const gl = cv.getContext("webgl", { antialias: false, preserveDrawingBuffer: false });
    if (!gl) { cv.replaceWith(Object.assign(document.createElement("div"), { textContent: "เบราว์เซอร์ไม่รองรับ WebGL", className: "p-4 text-sm text-zinc-500" })); return; }
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const U = { yaw: u("yaw"), pitch: u("pitch"), tanHalf: u("tanHalf"), aspect: u("aspect"), cx: u("cx"), cy: u("cy"), rad: u("rad"), thetaMax: u("thetaMax"), texW: u("texW"), texH: u("texH") };

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const vid = getVideo();
      if (!vid || vid.readyState < 2 || !vid.videoWidth) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      gl.viewport(0, 0, w, h);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, vid);
      } catch {
        return; // frame not ready / cross-origin
      }
      const W = vid.videoWidth, H = vid.videoHeight, v = view.current;
      gl.uniform1f(U.yaw, v.yaw);
      gl.uniform1f(U.pitch, v.pitch);
      gl.uniform1f(U.tanHalf, Math.tan(((v.fov / 2) * Math.PI) / 180));
      gl.uniform1f(U.aspect, w / h);
      gl.uniform1f(U.cx, cal.cx * W);
      gl.uniform1f(U.cy, cal.cy * H);
      gl.uniform1f(U.rad, cal.r * W);
      gl.uniform1f(U.thetaMax, ((cal.fov / 2) * Math.PI) / 180);
      gl.uniform1f(U.texW, W);
      gl.uniform1f(U.texH, H);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    raf = requestAnimationFrame(draw);

    // ── interaction ──
    const maxPitch = Math.min(((cal.fov / 2 - 5) * Math.PI) / 180, (88 * Math.PI) / 180);
    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const v = view.current;
      // radians per screen pixel at the current zoom, so the picture follows the pointer
      const k = (((v.fov * Math.PI) / 180) / Math.max(1, cv.clientHeight));
      v.yaw -= (e.clientX - drag.x) * k;
      v.pitch = Math.max(0, Math.min(maxPitch, v.pitch + (e.clientY - drag.y) * k));
      drag = { x: e.clientX, y: e.clientY };
    };
    const up = () => { drag = null; };
    const wheel = (e: WheelEvent) => { e.preventDefault(); const v = view.current; v.fov = Math.max(20, Math.min(120, v.fov * Math.exp(e.deltaY * 0.001))); };
    const reset = () => { view.current = { ...DEFAULT }; };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", wheel, { passive: false });
    cv.addEventListener("dblclick", reset);
    return () => {
      cancelAnimationFrame(raf);
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
      cv.removeEventListener("wheel", wheel);
      cv.removeEventListener("dblclick", reset);
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, [getVideo, cal.cx, cal.cy, cal.r, cal.fov]);

  return (
    <canvas
      ref={canvas}
      className={className ?? "h-full w-full cursor-grab touch-none active:cursor-grabbing"}
      title="ลากเพื่อหมุนดู · เลื่อนลูกกลิ้งเพื่อซูม · ดับเบิลคลิกเพื่อกลับมุมเริ่มต้น"
    />
  );
}
