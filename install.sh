#!/bin/bash
set -euo pipefail

# Familiar — systemd service installer

SERVICE_NAME="familiar"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME.service"

# Find familiar binary
FAMILIAR_BIN=$(command -v familiar 2>/dev/null || echo "")
if [ -z "$FAMILIAR_BIN" ]; then
  echo "Error: 'familiar' not found in PATH."
  echo "Install it first: npm install -g familiar"
  exit 1
fi

echo "Installing $SERVICE_NAME systemd user service..."

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Familiar — AI Assistant Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$FAMILIAR_BIN start
Restart=always
RestartSec=10
Environment=HOME=$HOME
Environment=NODE_ENV=production
Environment=PATH=$PATH

[Install]
WantedBy=default.target
EOF

echo "Service file written to $SERVICE_FILE"

# Reload systemd
systemctl --user daemon-reload

echo ""
echo "To enable and start:"
echo "  systemctl --user enable $SERVICE_NAME"
echo "  systemctl --user start $SERVICE_NAME"
echo ""
echo "To check status:"
echo "  systemctl --user status $SERVICE_NAME"
echo "  journalctl --user -u $SERVICE_NAME -f"
echo ""
echo "To stop:"
echo "  systemctl --user stop $SERVICE_NAME"
echo "  systemctl --user disable $SERVICE_NAME"
