"""Real-time face entry/exit worker (Phase 3).

  FACE_THREADS=4 .venv/bin/python worker.py          (systemd: infra/systemd/cctv-face.service)

For every camera with faceEnabled (config from the API, refreshed every 30 s):
  ffmpeg reads the go2rtc restream, crops it to the camera's zone and outputs ~5 fps raw frames
  → cheap motion check on a thumbnail (detector only runs while something moves in the zone)
  → SCRFD face detection + ArcFace embedding (InsightFace buffalo_l, CPU)
  → online tracker (one track = one person passing)
  → when a track ends: best match against gallery.npz → AccessEvent posted to the API,
    best face crop saved under FACE_DATA_DIR/events/<local date>/.

Face templates never leave this process/server; the API only receives code, scores and the crop.
Thresholds are env-tunable (see CFG). Times sent to the API are UTC ISO strings.
"""
import datetime as dt
import hashlib
import hmac
import json
import os
import queue
import shutil
import signal
import subprocess
import threading
import time
import urllib.request
import uuid

os.environ.setdefault("FACE_THREADS", "4")

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from common import detect, embed  # noqa: E402  (patches onnxruntime threads on import)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../.."))
TZ = dt.timezone(dt.timedelta(hours=7))


def _env_file(path):
    out = {}
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out


_api_env = _env_file(os.path.join(ROOT, "apps/api/.env"))


def _cfg(name, default, cast=float):
    return cast(os.environ.get(name, default))


CFG = {
    "api": os.environ.get("FACE_API_URL", "http://127.0.0.1:3000").rstrip("/"),
    "data": os.environ.get("FACE_DATA_DIR") or _api_env.get("FACE_DATA_DIR") or os.path.join(ROOT, "data/face"),
    "fps": _cfg("FACE_FPS", 5),
    "min_face": _cfg("FACE_MIN_FACE", 40),
    "det_thresh": _cfg("FACE_DET_THRESH", 0.5),
    "match_sim": _cfg("FACE_MATCH_SIM", 0.45),
    "match_margin": _cfg("FACE_MATCH_MARGIN", 0.10),
    "uncertain_sim": _cfg("FACE_UNCERTAIN_SIM", 0.35),
    "track_gap": _cfg("FACE_TRACK_GAP", 2.0),
    "min_frames": _cfg("FACE_MIN_FRAMES", 2, int),
    "unknown_min_frames": _cfg("FACE_UNKNOWN_MIN_FRAMES", 3, int),
    "unknown_min_face": _cfg("FACE_UNKNOWN_MIN_FACE", 50),
    "motion_ratio": _cfg("FACE_MOTION_RATIO", 0.003),
    "snapshot_days": _cfg("FACE_SNAPSHOT_DAYS", 30, int),
}
SECRET = os.environ.get("APP_SECRET") or _api_env.get("APP_SECRET", "")
TOKEN = hmac.new(SECRET.encode(), b"face-worker", hashlib.sha256).hexdigest()
STOP = threading.Event()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def api(method, path, body=None, timeout=10):
    req = urllib.request.Request(
        CFG["api"] + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"X-Worker-Token": TOKEN, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def iso(t):
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat().replace("+00:00", "Z")


# ── gallery ─────────────────────────────────────────────────────────────────────────────────
class Gallery:
    def __init__(self, path):
        self.path, self.mtime, self.lock = path, 0, threading.Lock()
        self.G = self.inv = self.codes = None
        self.names = {}
        self.loaded_at = None
        self.reload()

    def reload(self):
        try:
            m = os.path.getmtime(self.path)
        except OSError:
            return
        if m == self.mtime:
            return
        g = np.load(self.path)
        codes, inv = np.unique(g["code"], return_inverse=True)
        with self.lock:
            self.G, self.codes, self.inv = g["emb"].astype(np.float32), codes, inv
            self.names = dict(zip(g["names_code"].tolist(), g["names_name"].tolist()))
            self.mtime, self.loaded_at = m, time.time()
        log(f"gallery loaded: {len(codes)} employees, {len(self.G)} templates")

    def top(self, E, k=3):
        """Per-employee max cosine over track frames × that employee's photos → top-k."""
        with self.lock:
            sims = (E @ self.G.T).max(axis=0)
            score = np.full(len(self.codes), -1.0, dtype=np.float32)
            np.maximum.at(score, self.inv, sims)
            idx = np.argsort(-score)[:k]
            return [{"code": str(self.codes[i]), "name": str(self.names.get(self.codes[i], "")), "sim": round(float(score[i]), 4)} for i in idx]

    def info(self):
        if self.G is None:
            return None
        return {"employees": int(len(self.codes)), "templates": int(len(self.G)), "loadedAt": iso(self.loaded_at)}


# ── event posting (separate thread so the camera loops never wait on HTTP) ───────────────────
OUTBOX: "queue.Queue[dict]" = queue.Queue(maxsize=1000)


def poster():
    while not (STOP.is_set() and OUTBOX.empty()):
        try:
            ev = OUTBOX.get(timeout=1)
        except queue.Empty:
            continue
        for attempt in range(30):
            try:
                r = api("POST", "/api/face/worker/events", ev)
                drop = r.get("dropSnapshot")
                if drop:
                    p = os.path.join(CFG["data"], drop)
                    if os.path.abspath(p).startswith(os.path.abspath(CFG["data"]) + os.sep) and os.path.exists(p):
                        os.remove(p)
                break
            except Exception as e:  # API restarting (bun --watch) etc. → retry for ~5 min
                if attempt == 0:
                    log("post failed, retrying:", e)
                if STOP.wait(10):
                    return


# ── per-camera pipeline ────────────────────────────────────────────────────────────────────
def probe_size(url):
    out = subprocess.run(
        ["ffprobe", "-v", "error", *(["-rtsp_transport", "tcp"] if url.startswith("rtsp") else []), "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "json", url],
        capture_output=True, text=True, timeout=20,
    )
    s = json.loads(out.stdout)["streams"][0]
    return int(s["width"]), int(s["height"])


class Camera(threading.Thread):
    def __init__(self, cfg, gallery):
        super().__init__(daemon=True, name=f"cam-{cfg['id']}")
        self.cfg, self.gallery = cfg, gallery
        self.halt = threading.Event()
        self.proc = None
        self.frame = None  # (t, img)
        self.cond = threading.Condition()
        self.stats = {"running": False, "fps": 0.0, "processedFps": 0.0, "busyPct": 0.0, "tracks": 0, "events": 0, "lastError": None}
        self.tracks = []
        self.next_id = 0

    # reader: keeps only the newest frame; the processing loop skips whatever it cannot keep up with
    def reader(self, w, h):
        size = w * h * 3
        n, t0 = 0, time.time()
        while not self.halt.is_set():
            buf = self.proc.stdout.read(size)
            if not buf or len(buf) < size:
                break
            img = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            with self.cond:
                self.frame = (time.time(), img)
                self.cond.notify()
            n += 1
            if time.time() - t0 >= 10:
                self.stats["fps"] = round(n / (time.time() - t0), 1)
                n, t0 = 0, time.time()
        with self.cond:
            self.frame = None
            self.cond.notify()

    def run(self):
        while not self.halt.is_set() and not STOP.is_set():
            try:
                self.session()
            except Exception as e:
                self.stats["lastError"] = str(e)[:300]
                log(f"[{self.cfg['deviceNo']}] error:", e)
            self.stats["running"] = False
            self.flush(force=True)
            if self.halt.wait(10):
                break

    def session(self):
        url = self.cfg["rtsp"]
        W, H = probe_size(url)
        z = self.cfg["zone"] or [0, 0, 1, 1]
        x0, y0 = int(z[0] * W) // 2 * 2, int(z[1] * H) // 2 * 2
        x1, y1 = int(z[2] * W) // 2 * 2, int(z[3] * H) // 2 * 2
        w, h = x1 - x0, y1 - y0
        if w < 64 or h < 64:
            raise ValueError("zone too small")
        self.det_size = (min(1280, -(-w // 32) * 32), min(1280, -(-h // 32) * 32))
        self.proc = subprocess.Popen(
            # a file path (replay test, see replay.py) is read at real-time speed like a live stream
            ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
             *(["-rtsp_transport", "tcp"] if url.startswith("rtsp") else ["-re"]), "-i", url, "-an",
             "-vf", f"fps={CFG['fps']},crop={w}:{h}:{x0}:{y0}", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=w * h * 3,
        )
        log(f"[{self.cfg['deviceNo']}] {W}x{H} zone {x0},{y0},{x1},{y1} det {self.det_size} dir {self.cfg['direction']}")
        rd = threading.Thread(target=self.reader, args=(w, h), daemon=True)
        rd.start()
        self.stats.update(running=True, lastError=None)
        prev_small, motion_until, last_t = None, 0.0, 0.0
        busy, done, w0 = 0.0, 0, time.time()
        try:
            while not self.halt.is_set():
                waited = time.time()
                with self.cond:
                    while (self.frame is None or self.frame[0] <= last_t) and rd.is_alive() and not self.halt.is_set():
                        if time.time() - waited > 30:
                            raise RuntimeError("no frames for 30 s")
                        self.cond.wait(1)
                    fr = self.frame
                if self.halt.is_set():
                    break
                if fr is None or not rd.is_alive():
                    raise RuntimeError("stream ended")
                t, img = fr
                last_t = t
                # motion gate on a 256-px grey thumbnail
                small = cv2.GaussianBlur(cv2.cvtColor(cv2.resize(img, (256, max(16, 256 * h // w))), cv2.COLOR_BGR2GRAY), (5, 5), 0)
                if prev_small is not None and (cv2.absdiff(small, prev_small) > 18).mean() > CFG["motion_ratio"]:
                    motion_until = t + 1.5
                prev_small = small
                if t <= motion_until or self.tracks:
                    s = time.time()
                    self.process(t, img)
                    busy += time.time() - s
                    done += 1
                self.flush(now=t)
                if time.time() - w0 >= 10:
                    el = time.time() - w0
                    self.stats.update(processedFps=round(done / el, 1), busyPct=round(100 * busy / el), tracks=len(self.tracks))
                    busy, done, w0 = 0.0, 0, time.time()
        finally:
            self.kill()

    def process(self, t, img):
        dets = []
        for f in detect(img, self.det_size, CFG["det_thresh"]):
            bw = float(f.bbox[2] - f.bbox[0])
            if bw < CFG["min_face"]:
                continue
            dets.append((f, bw, embed(img, f)))
        for f, bw, e in sorted(dets, key=lambda d: -d[1]):
            cx, cy = (f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2
            best, bd = None, 1e9
            for tr in self.tracks:
                if t - tr["last_t"] > CFG["track_gap"] or tr["seen_at"] == t:
                    continue
                d = abs(cx - tr["cx"]) + abs(cy - tr["cy"])
                if d < 4 * max(bw, tr["w"]) and d < bd and float(e @ tr["last_emb"]) > 0.2:
                    best, bd = tr, d
            if best is None:
                best = {"id": self.next_id, "start": t, "frames": 0, "embs": [], "max_w": 0, "best_q": -1, "snap": None}
                self.next_id += 1
                self.tracks.append(best)
            q = bw * float(f.det_score)
            best.update(last_t=t, seen_at=t, cx=cx, cy=cy, w=bw, last_emb=e)
            best["frames"] += 1
            best["max_w"] = max(best["max_w"], bw)
            best["embs"].append((q, e))
            if len(best["embs"]) > 15:
                best["embs"].sort(key=lambda x: -x[0])
                best["embs"].pop()
            if q > best["best_q"]:
                b = [int(v) for v in f.bbox]
                pad = int(bw * 0.6)
                best["best_q"] = q
                best["snap"] = img[max(0, b[1] - pad):b[3] + pad, max(0, b[0] - pad):b[2] + pad].copy()

    def flush(self, now=None, force=False):
        keep = []
        for tr in self.tracks:
            if force or now - tr["last_t"] > CFG["track_gap"]:
                self.finish(tr)
            else:
                keep.append(tr)
        self.tracks = keep

    def finish(self, tr):
        if tr["frames"] < CFG["min_frames"] or self.gallery.G is None:
            return
        E = np.stack([e for _, e in tr["embs"]]).astype(np.float32)
        top = self.gallery.top(E)
        s1, s2 = top[0]["sim"], top[1]["sim"] if len(top) > 1 else 0.0
        if s1 >= CFG["match_sim"] and s1 - s2 >= CFG["match_margin"]:
            status = "MATCHED"
        elif s1 >= CFG["uncertain_sim"]:
            status = "UNCERTAIN"
        else:
            status = "UNKNOWN"
            if tr["frames"] < CFG["unknown_min_frames"] or tr["max_w"] < CFG["unknown_min_face"]:
                return  # brief/small unknown faces are mostly noise
        rel = None
        if tr["snap"] is not None and tr["snap"].size:
            day = dt.datetime.fromtimestamp(tr["start"], TZ).strftime("%Y-%m-%d")
            rel = f"events/{day}/{uuid.uuid4().hex}.jpg"
            os.makedirs(os.path.join(CFG["data"], "events", day), exist_ok=True)
            cv2.imwrite(os.path.join(CFG["data"], rel), tr["snap"], [cv2.IMWRITE_JPEG_QUALITY, 88])
        ev = {
            "cameraId": self.cfg["id"], "status": status,
            "empCode": top[0]["code"] if status != "UNKNOWN" else None,
            "empName": top[0]["name"] if status != "UNKNOWN" else None,
            "similarity": s1, "margin": round(s1 - s2, 4), "candidates": top,
            "firstSeenAt": iso(tr["start"]), "lastSeenAt": iso(tr["last_t"]),
            "frames": tr["frames"], "faceSize": int(tr["max_w"]), "snapshotPath": rel,
        }
        try:
            OUTBOX.put_nowait(ev)
            self.stats["events"] += 1
        except queue.Full:
            log("outbox full, dropping event")

    def kill(self):
        p = self.proc
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()

    def stop(self):
        self.halt.set()
        self.kill()


# ── housekeeping ───────────────────────────────────────────────────────────────────────────
def prune_snapshots():
    root = os.path.join(CFG["data"], "events")
    if not os.path.isdir(root):
        return
    cutoff = (dt.datetime.now(TZ) - dt.timedelta(days=CFG["snapshot_days"])).strftime("%Y-%m-%d")
    for d in os.listdir(root):
        if len(d) == 10 and d < cutoff:
            shutil.rmtree(os.path.join(root, d), ignore_errors=True)
            log("pruned snapshots", d)


def main():
    if not SECRET:
        raise SystemExit("APP_SECRET not found (env or apps/api/.env)")
    gallery = Gallery(os.path.join(CFG["data"], "gallery.npz"))
    if gallery.G is None:
        raise SystemExit("gallery.npz missing — run enroll.py first")
    for s in (signal.SIGINT, signal.SIGTERM):
        signal.signal(s, lambda *_: STOP.set())
    threading.Thread(target=poster, daemon=True, name="poster").start()
    cams: dict[int, Camera] = {}
    started = iso(time.time())
    next_cfg = next_status = next_prune = 0.0
    log("face worker started", {k: v for k, v in CFG.items() if k != "api"})
    while not STOP.is_set():
        now = time.time()
        if now >= next_cfg:
            next_cfg = now + 30
            try:
                conf = api("GET", "/api/face/worker/config")
                want = {c["id"]: c for c in conf["cameras"]}
                for cid in list(cams):
                    c = cams[cid]
                    if cid not in want or want[cid] != c.cfg or not c.is_alive():
                        c.stop()
                        del cams[cid]
                        log(f"camera {cid} stopped/reloaded")
                for cid, c in want.items():
                    if cid not in cams:
                        cams[cid] = Camera(c, gallery)
                        cams[cid].start()
                gallery.reload()
            except Exception as e:
                log("config fetch failed:", e)
        if now >= next_status:
            next_status = now + 10
            try:
                api("PUT", "/api/face/worker/status", {
                    "pid": os.getpid(), "startedAt": started, "gallery": gallery.info(),
                    "cameras": [{"cameraId": cid, **c.stats} for cid, c in cams.items()],
                })
            except Exception:
                pass
        if now >= next_prune:
            next_prune = now + 3600
            prune_snapshots()
        STOP.wait(1)
    log("stopping")
    for c in cams.values():
        c.stop()
    for c in cams.values():
        c.join(10)  # flushes open tracks
    deadline = time.time() + 10
    while not OUTBOX.empty() and time.time() < deadline:
        time.sleep(0.2)


if __name__ == "__main__":
    main()
