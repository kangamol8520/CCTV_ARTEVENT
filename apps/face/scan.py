"""Offline test: run face detection + recognition over central recordings and report tracks.

  .venv/bin/python scan.py --camera 1274 --from "2026-11-10 12:30" --to "2026-11-10 13:30" \
      --roi 300,150,2400,1250 --fps 3 --out ../../data/face/scan-1274

Writes <out>/tracks.json and <out>/crops/<track>.jpg (best face of each track, padded).
Times are local (Asia/Bangkok); recording file names are UTC.
"""
import argparse
import datetime as dt
import json
import os
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np

REC = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../data/recordings"))
TZ = dt.timezone(dt.timedelta(hours=7))


def files_between(cam, t0, t1):
    out = []
    root = os.path.join(REC, str(cam))
    for day in sorted(os.listdir(root)):
        if day.startswith("."):
            continue
        for f in sorted(os.listdir(os.path.join(root, day))):
            try:
                st = dt.datetime.strptime(f[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
            except ValueError:
                continue
            if t0 - dt.timedelta(minutes=2) <= st < t1:
                out.append((st, os.path.join(root, day, f)))
    return out


def scan_file(job):
    from common import detect, embed

    st, path, fps, roi, det_size, min_face = job
    cap = cv2.VideoCapture(path)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 15
    step = max(1, round(src_fps / fps))
    dets, i = [], -1
    while True:
        ok = cap.grab()
        if not ok:
            break
        i += 1
        if i % step:
            continue
        ok, img = cap.retrieve()
        if not ok:
            break
        x0, y0, x1, y1 = roi or (0, 0, img.shape[1], img.shape[0])
        crop = img[y0:y1, x0:x1]
        # det_size None = "auto": run the detector at (almost) the crop's native size so small
        # faces are not downscaled away — the whole point of cropping to the door.
        ds = det_size or (min(1280, -(-(x1 - x0) // 32) * 32), min(1280, -(-(y1 - y0) // 32) * 32))
        for f in detect(crop, ds, 0.5):
            f.bbox = f.bbox + np.array([x0, y0, x0, y0], dtype=np.float32)
            f.kps = f.kps + np.array([x0, y0], dtype=np.float32)
            w = float(f.bbox[2] - f.bbox[0])
            if w < min_face:
                continue
            e = embed(img, f)
            bx = [int(v) for v in f.bbox]
            pad = int(w * 0.6)
            c = img[max(0, bx[1] - pad):bx[3] + pad, max(0, bx[0] - pad):bx[2] + pad]
            ok2, jpg = cv2.imencode(".jpg", c, [cv2.IMWRITE_JPEG_QUALITY, 85])
            dets.append({
                "t": (st + dt.timedelta(seconds=i / src_fps)).timestamp(), "bbox": bx, "w": round(w), "score": round(f.det_score, 3),
                "emb": e.tolist(), "jpg": jpg.tobytes() if ok2 else b"",
            })
    return dets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", type=int, required=True)
    ap.add_argument("--from", dest="t0", required=True)
    ap.add_argument("--to", dest="t1", required=True)
    ap.add_argument("--fps", type=float, default=3)
    ap.add_argument("--roi", default="")
    ap.add_argument("--det", default="640", help="detector input size, or 'auto' = ROI size (max 1280)")
    ap.add_argument("--min-face", type=int, default=20)
    ap.add_argument("--gallery", default=os.path.join(os.path.dirname(__file__), "../../data/face/gallery.npz"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=5)
    a = ap.parse_args()

    t0 = dt.datetime.strptime(a.t0, "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    t1 = dt.datetime.strptime(a.t1, "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    roi = tuple(int(v) for v in a.roi.split(",")) if a.roi else None
    files = files_between(a.camera, t0, t1)
    print(f"{len(files)} files")

    dets = []
    with ProcessPoolExecutor(a.workers) as ex:
        for d in ex.map(scan_file, [(st, p, a.fps, roi, None if a.det == "auto" else (int(a.det), int(a.det)), a.min_face) for st, p in files]):
            dets += d
    dets.sort(key=lambda d: d["t"])
    print(f"{len(dets)} face detections")

    # ── tracking: link detections close in time and space ──
    tracks = []
    for d in dets:
        cx, cy = (d["bbox"][0] + d["bbox"][2]) / 2, (d["bbox"][1] + d["bbox"][3]) / 2
        best = None
        for tr in reversed(tracks[-30:]):
            last = tr["dets"][-1]
            if d["t"] - last["t"] > 2.0:
                continue
            lx, ly = (last["bbox"][0] + last["bbox"][2]) / 2, (last["bbox"][1] + last["bbox"][3]) / 2
            if abs(cx - lx) + abs(cy - ly) < 4 * max(d["w"], last["w"]) and float(np.dot(d["emb"], last["emb"])) > 0.2:
                best = tr
                break
        if best:
            best["dets"].append(d)
        else:
            tracks.append({"dets": [d]})

    # ── recognition: per track, per employee max similarity over frames × gallery photos ──
    g = np.load(a.gallery)
    G, codes = g["emb"], g["code"]
    names = dict(zip(g["names_code"], g["names_name"]))
    ucodes, inv = np.unique(codes, return_inverse=True)
    os.makedirs(os.path.join(a.out, "crops"), exist_ok=True)
    out = []
    for n, tr in enumerate(tracks):
        E = np.array([d["emb"] for d in tr["dets"]], dtype=np.float32)
        sims = (E @ G.T).max(axis=0)  # best frame per gallery photo
        score = np.full(len(ucodes), -1.0, dtype=np.float32)
        np.maximum.at(score, inv, sims)  # best photo per employee
        top = np.argsort(-score)[:3]
        bestd = max(tr["dets"], key=lambda d: d["w"] * d["score"])
        crop_name = f"{n:05d}.jpg"
        open(os.path.join(a.out, "crops", crop_name), "wb").write(bestd["jpg"])
        out.append({
            "track": n, "start": tr["dets"][0]["t"], "end": tr["dets"][-1]["t"], "frames": len(tr["dets"]),
            "maxFace": max(d["w"] for d in tr["dets"]), "crop": crop_name, "bestBox": bestd["bbox"],
            "candidates": [{"code": str(ucodes[k]), "name": str(names.get(ucodes[k], "")), "sim": round(float(score[k]), 3)} for k in top],
        })
    json.dump({"camera": a.camera, "from": a.t0, "to": a.t1, "roi": roi, "tracks": out}, open(os.path.join(a.out, "tracks.json"), "w"), ensure_ascii=False)
    sims = [t["candidates"][0]["sim"] for t in out]
    print(f"{len(out)} tracks; top-1 sim ≥0.45: {sum(s >= 0.45 for s in sims)}, 0.35–0.45: {sum(0.35 <= s < 0.45 for s in sims)}, <0.35: {sum(s < 0.35 for s in sims)}")


if __name__ == "__main__":
    main()
