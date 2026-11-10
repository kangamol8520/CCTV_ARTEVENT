# systemd units (Ubuntu dev/server box)

Paths assume user `adminae` and the repo at `/home/adminae/CCTV`; edit `User=` / paths for another host.

```bash
sudo cp infra/systemd/cctv-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cctv-api cctv-web cctv-recorder cctv-face
```

Logs: `journalctl -u cctv-recorder -f` (same for `cctv-api`, `cctv-web`).
Restart after a code change outside `apps/api` watch scope: `sudo systemctl restart cctv-recorder`.

Docker services (MSSQL, go2rtc) come back on boot through `restart: unless-stopped` in docker-compose.yml.

`cctv-face` (face entry/exit worker) needs the Python venv and the employee gallery first:

```bash
cd apps/face && uv venv --python 3.12 && uv pip install -r requirements.txt
.venv/bin/python enroll.py --json ../../data/employees/Emp.json --photos ../../data/employees/photos --out ../../data/face/gallery.npz
```
Restart it after re-enrolling or changing worker code: `sudo systemctl restart cctv-face`.
