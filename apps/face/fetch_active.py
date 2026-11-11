"""Fetches the list of CURRENT employees from the HR API (resigned staff are not returned)
and writes data/employees/active.json. Emp.json stays the full master (names + photo paths);
enroll.py --active and the API use active.json to drop people who have left.

  python3 fetch_active.py [--url URL] [--ca ../api/certs/registry-ca.pem] [--out ../../data/employees/active.json]

Refuses to overwrite with a suspiciously small list (API error / partial response).
"""
import argparse
import json
import os
import ssl
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="https://workspace-ae.ae.local:30009/api/v2/getemployee")
    ap.add_argument("--ca", default=os.path.join(HERE, "../api/certs/registry-ca.pem"))
    ap.add_argument("--out", default=os.path.join(HERE, "../../data/employees/active.json"))
    ap.add_argument("--min", type=int, default=300, help="minimum rows to accept")
    a = ap.parse_args()
    ctx = ssl.create_default_context(cafile=a.ca if os.path.exists(a.ca) else None)
    with urllib.request.urlopen(a.url, context=ctx, timeout=60) as r:
        rows = json.loads(r.read())
    if not isinstance(rows, list) or len(rows) < a.min or "EmpCode" not in rows[0]:
        raise SystemExit(f"unexpected response ({type(rows).__name__}, {len(rows) if isinstance(rows, list) else '-'} rows) — not saved")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + ".tmp"
    json.dump(rows, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, a.out)
    print(f"{len(rows)} active employees → {a.out}")


if __name__ == "__main__":
    main()
