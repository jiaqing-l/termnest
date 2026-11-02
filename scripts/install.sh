#!/usr/bin/env bash
# Installs dependencies and the tmux-web systemd service. Safe to run again.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${TW_PORT:-7681}"
NODE="$(command -v node)"

cd "$DIR"
npm install --omit=dev --no-audit --no-fund
mkdir -p data
chmod 700 data

cat > /etc/systemd/system/tmux-web.service <<EOF
[Unit]
Description=Termnest
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
Environment=TW_PORT=$PORT
ExecStart=$NODE $DIR/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tmux-web >/dev/null
systemctl restart tmux-web
echo "Đã chạy Termnest ở http://127.0.0.1:$PORT"
