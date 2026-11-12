"""Replay test: feed a recorded file through the live worker pipeline and print the events
instead of posting them (nothing is written to the database; snapshots go to --out).

  .venv/bin/python replay.py --camera 1274 --file ../../data/recordings/1274/.../x.mp4 --zone 0.1116,0.1579,0.9003,0.8158
"""
import argparse
import os
import queue
import time

import worker


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", type=int, required=True)
    ap.add_argument("--file", nargs="+", required=True)
    ap.add_argument("--zone", default="")
    ap.add_argument("--out", default="/tmp/face-replay")
    a = ap.parse_args()
    worker.CFG["data"] = a.out
    os.makedirs(a.out, exist_ok=True)
    gal = worker.Gallery(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../data/face/gallery.npz"))
    zone = [float(v) for v in a.zone.split(",")] if a.zone else None
    for f in a.file:
        cam = worker.Camera({"id": a.camera, "deviceNo": "replay", "direction": "IN", "zone": zone, "rtsp": f}, gal)
        t0 = time.time()
        try:
            cam.session()
        except RuntimeError:
            pass
        cam.flush(force=True)
        print(f"{os.path.basename(f)}: {time.time() - t0:.0f}s, stats {cam.stats}", flush=True)
        while True:
            try:
                ev = worker.OUTBOX.get_nowait()
            except queue.Empty:
                break
            print(f"  {ev['status']:9} {ev['empCode'] or '-':10} {ev['empName'] or '':30} sim={ev['similarity']:.2f} m={ev['margin']:.2f} frames={ev['frames']} face={ev['faceSize']}px dy={ev.get('travelY')} grow={ev.get('sizeGrowth')}")


if __name__ == "__main__":
    main()
