"""Fingerprint scan puller (ZKTeco F18 and compatible), READ ONLY.

  .venv/bin/python -u pull.py            # loop: every ATT_INTERVAL s (default 600)
  .venv/bin/python -u pull.py --once     # one pass, then exit

For every enabled scanner listed by the API (/api/attendance/worker/devices) it connects over the ZK
protocol (TCP 4370), downloads the stored scan log and posts the scans newer than what the API already
has. The device's whole log is sent by the protocol anyway (no date filter on the device); filtering is
done here. NEVER calls disable_device / clear_attendance / set_* — staff keep scanning normally and
ZKTime.Net keeps working.

Device times are Bangkok local wall-clock; they are converted to UTC before posting.
"""
import datetime as dt
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.request

from zk import ZK

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
API = os.environ.get("ATT_API_URL", "http://127.0.0.1:3000").rstrip("/")
SECRET = os.environ.get("APP_SECRET") or _api_env.get("APP_SECRET", "")
TOKEN = hmac.new(SECRET.encode(), b"attendance-worker", hashlib.sha256).hexdigest()
INTERVAL = int(os.environ.get("ATT_INTERVAL", 600))
# first pull of a device: how far back to import (the device itself keeps months)
BACKFILL_FROM = dt.datetime.fromisoformat(os.environ.get("ATT_BACKFILL_FROM", "2026-11-01")).replace(tzinfo=TZ)
# re-send a little overlap so scans written while we were reading are not missed (duplicates are dropped by the API)
OVERLAP = dt.timedelta(minutes=30)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def api(method, path, body=None, timeout=60):
    req = urllib.request.Request(
        API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"X-Worker-Token": TOKEN, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def pull(dev):
    since = BACKFILL_FROM
    if dev.get("lastPunchAt"):
        since = dt.datetime.fromisoformat(dev["lastPunchAt"].replace("Z", "+00:00")) - OVERLAP
    zk = ZK(dev["ip"], port=dev.get("port") or 4370, timeout=15, password=0, force_udp=False, ommit_ping=True)
    conn = zk.connect()
    try:
        info = {}
        try:
            dev_time = conn.get_time()  # naive local time
            info["clockOffsetSec"] = int(round((dev_time.replace(tzinfo=TZ) - dt.datetime.now(TZ)).total_seconds()))
        except Exception:
            pass
        for k, fn in (("serial", conn.get_serialnumber), ("firmware", conn.get_firmware_version)):
            try:
                info[k] = str(fn())
            except Exception:
                pass
        try:
            conn.read_sizes()
            info["records"] = int(conn.records)
        except Exception:
            pass
        t0 = time.time()
        logs = conn.get_attendance()
        took = time.time() - t0
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
    rows = []
    for a in logs:
        ts = a.timestamp.replace(tzinfo=TZ)
        if ts < since:
            continue
        rows.append({"userId": str(a.user_id).strip(), "punchAt": ts.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
                     "status": int(a.status) if a.status is not None else None, "punch": int(a.punch) if a.punch is not None else None})
    inserted = 0
    chunks = [rows[i:i + 2000] for i in range(0, len(rows), 2000)] or [[]]
    for i, chunk in enumerate(chunks):
        r = api("POST", f"/api/attendance/worker/devices/{dev['id']}/punches", {"punches": chunk, **({"info": info} if i == len(chunks) - 1 else {})})
        inserted += r.get("inserted", 0)
    log(f"[{dev['alias']} {dev['ip']}] {len(logs)} on device ({took:.1f}s), {len(rows)} since {since.astimezone(TZ):%Y-%m-%d %H:%M}, {inserted} new"
        + (f", clock {info['clockOffsetSec']:+d}s" if "clockOffsetSec" in info else ""))


def one_pass():
    devs = api("GET", "/api/attendance/worker/devices")
    for d in devs:  # one at a time: a scanner serves one connection, ZKTime.Net may be talking to it too
        try:
            pull(d)
        except Exception as e:
            log(f"[{d['alias']} {d['ip']}] failed: {type(e).__name__}: {e}")
            try:
                api("POST", f"/api/attendance/worker/devices/{d['id']}/error", {"error": f"{type(e).__name__}: {e}"})
            except Exception:
                pass


def main():
    if not SECRET:
        raise SystemExit("APP_SECRET not found (env or apps/api/.env)")
    log("attendance puller started", {"api": API, "interval": INTERVAL, "backfillFrom": BACKFILL_FROM.isoformat()})
    while True:
        try:
            one_pass()
        except Exception as e:
            log("pass failed:", e)
        if "--once" in sys.argv:
            return
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
