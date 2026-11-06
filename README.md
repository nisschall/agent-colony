# Agent Colony

A live pixel town of every Claude Code and Codex agent on this Mac: who is working, waiting on you, burning out, and what it all costs. It reads the session logs in `~/.claude/projects` and `~/.codex/sessions`.

## Install (server + live wallpaper, both start at login)

```bash
./install-autostart.sh
```

This builds `build/ColonyWallpaper.app` (needs the Xcode command line tools) and installs two login items. Remove both with `./install-autostart.sh --remove`. Logs go to `~/Library/Logs/agent-colony.log`.

## Using the wallpaper

- The town is drawn on every screen, behind your windows and desktop icons, at about 15 frames a second.
- **Work mode:** press **⌃⌥⌘C** (or use the 🏙 menu-bar icon) to bring the town to the front and click it: hire agents (right-click a building), start a new app (click empty ground), answer the review queue. Press ⌃⌥⌘C again or click any other app to send it back.
- The menu-bar icon (a building) shows how many agents are waiting on you, and a red dot when any are overworked or stuck. Its menu lists who is waiting (click one to jump to it), today's spend, "Start a new app or chat…", and **Time of day** to preview dawn, noon, golden hour, dusk or night (or follow the clock).
- Idle agents relax in the **Rec Center** (ping-pong, coffee bar, sofas, arcade) or wander the park; sleeping agents use its nap pods.
- **Buildings describe their project:** size sets the type (cottage → tower, or a campus for multi-module repos), detected features add a dish (API), silo (database), mast (messaging), guard booth (security), dome (AI), clock tower (jobs), containers (Docker), lab (tests) or flag (CI), and the matching piece lights up while an agent edits that part. Smoke means recent errors, a crane means a heavy day, vines mean untouched for a week. Hover a building for the details.
- **Every day is a little different:** the weather (clear, breezy, drizzle, morning fog), traffic, kids at the fountain, the food truck and the odd hot-air balloon are picked from the date. A delivery van visits a building when one of its agents finishes a task.
- **Your town has its own layout:** plot positions, crosswalks, sidewalks, the park's paths and centrepiece (fountain, duck pond or statue), which side the Rec Center sits on, and the town edge (river, pond or tree line) come from a seed stored in `town.json`. Every screen shows the same town. 🎲 in the toolbar or **Rebuild town…** in the menu-bar menu rolls a new one; each project keeps its building.
- After editing `server.js`, `index.html` or `wallpaper/main.swift`, run `./install-autostart.sh` again.

## Run by hand

```bash
node server.js
```

Open http://localhost:4747 (full game) or http://localhost:4747/?wallpaper (slim mode).

## Settings

- `PORT` (default 4747), `HISTORY_DAYS` (default 30), `PROJECTS_FOLDER` (where new apps are created), `CLAUDE_BIN`.
- Prices per model are in `PRICES` at the top of `server.js`; Codex rates are a placeholder.
- Agents hired from the town may edit files in their project and run the commands in `ALLOWED_TOOLS`.
