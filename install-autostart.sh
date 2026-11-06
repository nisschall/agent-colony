#!/bin/zsh
# Installs two macOS login items (launchd agents):
#   com.agentcolony.server     keeps the Agent Colony server running
#   com.agentcolony.wallpaper  shows the town as a live wallpaper on every screen
# Usage: ./install-autostart.sh            build, install or refresh both
#        ./install-autostart.sh --remove   uninstall both
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_FILE="$HOME/Library/Logs/agent-colony.log"
DOMAIN="gui/$(id -u)"
SERVER_LABEL="com.agentcolony.server"
WALLPAPER_LABEL="com.agentcolony.wallpaper"
WALLPAPER_APP="$APP_DIR/build/ColonyWallpaper.app"

for label in "$SERVER_LABEL" "$WALLPAPER_LABEL"; do
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
done

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$AGENTS_DIR/$SERVER_LABEL.plist" "$AGENTS_DIR/$WALLPAPER_LABEL.plist"
  echo "Agent Colony login items removed."
  exit 0
fi

build_wallpaper_app() {
  mkdir -p "$WALLPAPER_APP/Contents/MacOS"
  cp "$APP_DIR/wallpaper/Info.plist" "$WALLPAPER_APP/Contents/Info.plist"
  swiftc -O -swift-version 5 "$APP_DIR/wallpaper/main.swift" -o "$WALLPAPER_APP/Contents/MacOS/ColonyWallpaper" \
    -framework AppKit -framework WebKit -framework Carbon
  codesign --force -s - "$WALLPAPER_APP" >/dev/null 2>&1
}

# write_agent <label> <keep-alive xml> <program> [args...]
write_agent() {
  local label="$1" keep_alive="$2"
  shift 2
  local arguments=""
  for argument in "$@"; do arguments+="    <string>$argument</string>"$'\n'; done
  cat > "$AGENTS_DIR/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$arguments  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>$keep_alive
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):$CLAUDE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict>
</plist>
EOF
  launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$label.plist"
}

NODE_BIN="$(command -v node)"
CLAUDE_DIR="$(dirname "$(command -v claude || echo "$HOME/.local/bin/claude")")"
mkdir -p "$AGENTS_DIR" "$HOME/Library/Logs"

echo "Building Colony Wallpaper…"
build_wallpaper_app

# The server always restarts; the wallpaper restarts after a crash but stays closed if you choose Quit.
write_agent "$SERVER_LABEL" "<true/>" "$NODE_BIN" "$APP_DIR/server.js"
write_agent "$WALLPAPER_LABEL" "<dict><key>SuccessfulExit</key><false/></dict>" "$WALLPAPER_APP/Contents/MacOS/ColonyWallpaper"

echo "Agent Colony server and wallpaper now start at login."
echo "Work in the colony: ⌃⌥⌘C or the 🏙 menu-bar icon. Logs: $LOG_FILE"
