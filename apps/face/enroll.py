"""Builds the employee face gallery from Emp.json + photo folder.

  .venv/bin/python enroll.py --json ../../data/employees/Emp.json --photos ../../data/employees/photos \
      --out ../../data/face/gallery.npz

With --active (data/employees/active.json from fetch_active.py) only current employees are
enrolled — people who have left are dropped from the gallery.

Photos used per employee: photos/<basename of PictPath>, else photos/<EmpCode>.<ext>.
(photos/FP holds fingerprint scans, not faces — never read.)
"""
import argparse
import json
import os
import re
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np

IMG_EXT = (".jpg", ".jpeg", ".png", ".jfif", ".bmp")


def index_photos(root):
    by_name = {}
    for f in os.listdir(root):
        p = os.path.join(root, f)
        if os.path.isfile(p) and f.lower().endswith(IMG_EXT):
            by_name.setdefault(f.lower(), p)
            by_name.setdefault(os.path.splitext(f)[0].lower(), p)
    return by_name


def process(job):
    from common import detect, embed

    code, paths = job
    out = []
    for p in paths:
        img = cv2.imread(p)
        if img is None:
            out.append((code, p, None, "unreadable", 0))
            continue
        # Small ID photos: pad so the detector sees the face at a normal scale.
        h, w = img.shape[:2]
        if max(h, w) < 400:
            s = 400 / max(h, w)
            img = cv2.resize(img, (int(w * s), int(h * s)))
        faces = detect(img, (640, 640), 0.5)
        if not faces:
            out.append((code, p, None, "no_face", 0))
            continue
        f = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
        out.append((code, p, embed(img, f), "ok", int(f.bbox[2] - f.bbox[0])))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True)
    ap.add_argument("--photos", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--active", default="", help="active.json from fetch_active.py; enroll only these codes")
    a = ap.parse_args()

    rows = json.load(open(a.json, encoding="utf-8"))
    if a.active:
        active = {str(r["EmpCode"]).strip() for r in json.load(open(a.active, encoding="utf-8"))}
        before = len(rows)
        rows = [r for r in rows if str(r["EmpCode"]).strip() in active]
        missing = sorted(active - {str(r["EmpCode"]).strip() for r in rows})
        print(f"active filter: {before} → {len(rows)} employees; {len(missing)} active codes not in {os.path.basename(a.json)}: {missing[:20]}")
    by_name = index_photos(a.photos)
    jobs, names = [], {}
    for r in rows:
        code = str(r["EmpCode"]).strip()
        names[code] = r["EmpName"].strip()
        paths = []
        base = re.split(r"[\\/]", r.get("PictPath") or "")[-1].lower()
        for key in (base, code.lower()):
            if key and key in by_name and by_name[key] not in paths:
                paths.append(by_name[key])
        jobs.append((code, paths))

    embs, codes, srcs = [], [], []
    stats = {"employees": len(jobs), "no_photo": 0, "photos": 0, "ok": 0, "no_face": 0, "unreadable": 0, "employees_enrolled": 0}
    no_photo = [c for c, p in jobs if not p]
    stats["no_photo"] = len(no_photo)
    enrolled = set()
    with ProcessPoolExecutor(a.workers) as ex:
        for res in ex.map(process, [j for j in jobs if j[1]], chunksize=8):
            for code, p, e, status, fw in res:
                stats["photos"] += 1
                stats[status] += 1
                if e is not None:
                    embs.append(e)
                    codes.append(code)
                    srcs.append(os.path.relpath(p, a.photos))
                    enrolled.add(code)
    stats["employees_enrolled"] = len(enrolled)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    np.savez(a.out, emb=np.stack(embs), code=np.array(codes), src=np.array(srcs),
             names_code=np.array(list(names.keys())), names_name=np.array(list(names.values())))
    print(json.dumps(stats, ensure_ascii=False))
    print("no photo:", no_photo[:20], "..." if len(no_photo) > 20 else "")


if __name__ == "__main__":
    main()
