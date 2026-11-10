"""Contact sheet for reviewing scan.py results: camera crop | matched employee photo.

  .venv/bin/python sheet.py ../../data/face/scan-34 /tmp/sheet-34.jpg [--top 24] [--min-frames 3]
"""
import argparse
import datetime as dt
import json
import os
import re

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scan_dir")
    ap.add_argument("out")
    ap.add_argument("--top", type=int, default=24)
    ap.add_argument("--min-frames", type=int, default=3)
    ap.add_argument("--cols", type=int, default=4)
    a = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    emp = os.path.join(here, "../../data/employees")
    photos = os.path.join(emp, "photos")
    files = {f.lower(): f for f in os.listdir(photos)}
    photo = {}
    for r in json.load(open(os.path.join(emp, "Emp.json"), encoding="utf-8")):
        b = re.split(r"[\\/]", r["PictPath"])[-1].lower()
        if b in files:
            photo[r["EmpCode"]] = os.path.join(photos, files[b])

    d = json.load(open(os.path.join(a.scan_dir, "tracks.json"), encoding="utf-8"))
    tracks = [t for t in d["tracks"] if t["frames"] >= a.min_frames]
    tracks.sort(key=lambda t: -t["candidates"][0]["sim"])
    tiles = []
    for i, t in enumerate(tracks[: a.top]):
        c = t["candidates"][0]
        crop = cv2.imread(os.path.join(a.scan_dir, "crops", t["crop"]))
        ref = cv2.imread(photo[c["code"]]) if c["code"] in photo else None
        tile = np.full((190, 300, 3), 30, np.uint8)
        if crop is not None:
            tile[0:160, 0:160] = cv2.resize(crop, (160, 160))
        if ref is not None:
            tile[0:160, 165:295] = cv2.resize(ref, (130, 160))
        ts = dt.datetime.fromtimestamp(t["start"]).strftime("%H:%M:%S")
        label = f"#{i} {ts} s={c['sim']:.2f} m={c['sim'] - t['candidates'][1]['sim']:.2f} {t['maxFace']}px"
        cv2.putText(tile, label, (4, 182), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1)
        tiles.append(tile)
    while len(tiles) % a.cols:
        tiles.append(np.zeros((190, 300, 3), np.uint8))
    grid = np.vstack([np.hstack(tiles[r * a.cols:(r + 1) * a.cols]) for r in range(len(tiles) // a.cols)])
    cv2.imwrite(a.out, grid, [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(a.out, grid.shape)


if __name__ == "__main__":
    main()
