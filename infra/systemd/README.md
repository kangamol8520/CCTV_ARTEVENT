# systemd units (Ubuntu dev/server box)

Paths assume user `adminae` and the repo at `/home/adminae/CCTV`; edit `User=` / paths for another host.

```bash
sudo cp infra/systemd/cctv-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cctv-api cctv-web cctv-recorder
```

Logs: `journalctl -u cctv-recorder -f` (same for `cctv-api`, `cctv-web`).
Restart after a code change outside `apps/api` watch scope: `sudo systemctl restart cctv-recorder`.

Docker services (MSSQL, go2rtc) come back on boot through `restart: unless-stopped` in docker-compose.yml.
