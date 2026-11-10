# Agent Colony

A live pixel town of every Claude Code and Codex agent on this Mac: who is working, waiting on you, burning out, and what it all costs. It reads the session logs in `~/.claude/projects` and `~/.codex/sessions`.

**Version 0.2 — an early release.** It works day to day on one Mac, but expect rough edges, and update often (see [Known limits](#known-limits)).

## Requirements

- macOS for the live wallpaper and starting at login. The town page itself (`npm start`) is plain Node and may work elsewhere, but only macOS is tested.
- Node 18 or later.
- Claude Code and/or Codex, already used on this Mac (the town is built from their logs).
- The Xcode command line tools, to build the wallpaper app (`xcode-select --install`).

## Install (server + live wallpaper, both start at login)

```bash
git clone https://github.com/nisschall/agent-colony.git
cd agent-colony
./install-autostart.sh
```

This builds `build/ColonyWallpaper.app` and installs two login items. Remove both with `./install-autostart.sh --remove`. Logs go to `~/Library/Logs/agent-colony.log`.

To update, run `git pull` and then `./install-autostart.sh` again.

## Using the wallpaper

- The town is drawn on every screen, behind your windows and desktop icons, at about 15 frames a second.
- **Work mode:** press **⌃⌥⌘C** (or use the 🏙 menu-bar icon) to bring the town to the front and click it: hire agents (right-click a building), start a new app (click empty ground), answer the review queue. Press ⌃⌥⌘C again or click any other app to send it back.
- The menu-bar icon (a building) shows how many agents are waiting on you, and a red dot when any are overworked or stuck. Its menu lists who is waiting (click one to jump to it), today's spend, "Start a new app or chat…", and **Time of day** to preview dawn, noon, golden hour, dusk or night (or follow the clock).
- Idle agents relax in the **Rec Center** (ping-pong, coffee bar, sofas, arcade) or wander the park; sleeping agents use its nap pods.
- **Buildings describe their project:** size sets the type (cottage → tower, or a campus for multi-module repos), detected features add a dish (API), silo (database), mast (messaging), guard booth (security), dome (AI), clock tower (jobs), containers (Docker), lab (tests) or flag (CI), and the matching piece lights up while an agent edits that part. Smoke means recent errors, a crane means a heavy day, vines mean untouched for a week. Hover a building for the details.
- **Taller means more complex:** each project gets a complexity score from 0 to 100 (lines of code, features, modules, languages and dependencies), and the building's height follows it. The most complex projects (75 and up) become landmarks with a glass front, gold trim and a beacon, and a ★ before their name. Hover shows the score and what went into it.
- **Problems show on the building:** when an agent's last build or test run in a project failed, the building gets a warning sign by the door, a flashing roof light and a red "⚠ build failing" label until a later run passes. Tool errors in the last hour make it smoke. A yellow pulsing label means an agent there is waiting on you. Click the building to see each problem and jump to the agent.
- **Every day is a little different:** the weather (clear, breezy, drizzle, morning fog), traffic, kids at the fountain, the food truck and the odd hot-air balloon are picked from the date. A delivery van visits a building when one of its agents finishes a task.
- **Your town has its own layout:** plot positions, crosswalks, sidewalks, the park's paths and centrepiece (fountain, duck pond or statue), which side the Rec Center sits on, and the town edge (river, pond or tree line) come from a seed stored in `town.json`. Every screen shows the same town. 🎲 in the toolbar or **Rebuild town…** in the menu-bar menu rolls a new one; each project keeps its building.
- After changing the server or the wallpaper app, run `./install-autostart.sh` again. Changes to `public/` show up on the next page reload.

## Managing your agents

- **Click an agent** to open its card: what it was asked, what it is doing, files it changed and recent actions. **⤢** expands the card so you can read the whole conversation and talk to it: answer its question or give the next task.
- **Hire an agent** by right-clicking a building. Hired agents wear a vest.
- **When a hired agent stops,** its card says **🙋 Needs you** (it asked you something or was blocked) or **✓ Done**. Agents waiting on you also queue at the Review Office.
- **Blocked actions:** if a hired agent tried something it isn't allowed to do, the card lists it. **Allow once & retry** re-runs it with only those actions allowed, for that one run.
- **Release** (two clicks) sends a hired agent out of town. Its conversation stays in Claude's history.
- **A shell in a project's folder:** click a building for **Open Terminal here**, or type a command in its **Run** box (for example `./mvnw test`) to run it in a new Terminal window in that folder. The last few commands you ran there come back as one-click chips. An agent's card has **⌨ Shell** for its project's folder. Commands always run in Terminal, where you can see and stop them, never hidden inside the server; the first time, macOS asks to let Agent Colony control Terminal.

### What hired agents may do

Hired agents run `claude -p` in the project's folder with `--permission-mode acceptEdits`. That means **they edit files in the project without asking**, and they can run the commands listed in `ALLOWED_TOOLS` in `server/config.js` (read-only git, and common build and test commands). Anything else is blocked and shows on the card.

Hiring spends your own Claude usage. The costs the town shows are estimates from the prices in `server/pricing.js`, not your bill.

## Run by hand

```bash
npm start
```

Open http://localhost:4747 (full game) or http://localhost:4747/?wallpaper (slim mode).

## Settings

- `PORT` (default 4747), `HISTORY_DAYS` (default 30), `PROJECTS_FOLDER` (where new apps are created), `CLAUDE_BIN`.
- Prices per model are in `server/pricing.js`; Codex rates are a placeholder.
- Agents hired from the town may edit files in their project and run the commands in `ALLOWED_TOOLS` (`server/config.js`).

## Clans

A clan is a shared town: everyone's shared projects, their agents, who is waiting on whom, and recent activity, on a hub your team hosts (setup in [hub/README.md](hub/README.md)). You can be in several clans and pick which projects each one sees.

1. On the hub, sign in with GitHub. Unless you are a hub admin (or in the organisation the hub trusts), wait for an admin to let you in. Then create a clan, or join one with an invite code.
2. In your town, click **🛡** in the toolbar, enter the hub's address and **Link with GitHub**. You sign in on the hub in your browser and come back linked.
3. In the same panel, tick which projects each clan sees. **Open town** shows the clan's town.

Unlinking (in the panel, or on the hub's page) stops sharing straight away.

## Privacy

Everything stays on your Mac unless you link it to a clan hub. The server only listens on `127.0.0.1` and reads your local session logs. Once linked, it sends the hub a short summary of the projects you chose to share, and nothing about the others. That summary has no transcripts, prompts, code, commands or folder paths: the full list is in [hub/README.md](hub/README.md#what-members-share). `town.json`, `portal-agents.json` and `clan.json` (your layout, hired agents and hub link) are written next to the code and are not committed.

## Known limits

- **It reads Claude Code's and Codex's log files, which are not public APIs.** An update to either tool can change the format and quietly break things like the Needs you / Done status. If the town looks wrong after an update, pull the latest version and run `npm test`.
- Costs are estimates, and the Codex prices are a placeholder.
- When the server starts at login, macOS may stop it reading some folders (such as Downloads). Those projects still appear, but their building stays small because their size can't be measured.
- A build or test failure older than a day is no longer shown.

## Tests

```bash
npm test
```

The tests run sample Claude Code and Codex transcript lines through the log parsers, so a change in either log format shows up there first, and check what this Mac sends a clan hub.

The clan hub has its own tests, which need Node 22 (see [hub/README.md](hub/README.md)):

```bash
npm run test:hub
```

## Project layout

No npm dependencies and no build step: the server is plain Node, and the page loads its ES modules straight from `public/`.

| Path | What it holds |
|---|---|
| `server/index.js` | HTTP routes, the live update stream, serving the page |
| `server/logs/` | Parsers for Claude Code and Codex session logs |
| `server/agents.js` | Agent records, daily stats, stress and status |
| `server/projects.js` | Project names, stack, size and feature detection |
| `server/scanner.js` | Finding and tailing session logs |
| `server/snapshot.js` | The colony state sent to the page |
| `server/portal.js` | Hiring agents, orders, retry, stop, release, Open in Terminal |
| `server/conversation.js` | An agent's conversation, actions and changed files, for its card |
| `server/checks.js` | Failing builds and tests, and recent errors, per project |
| `server/clan.js` | Linking this Mac to a clan hub, choosing shared projects, sending the summary |
| `hub/` | The clan hub: GitHub sign-in, approvals, clans, SQLite storage and deploy files (runs on a server, Node 22) |
| `server/town.js`, `server/pricing.js`, `server/config.js` | Layout seed, model prices, settings |
| `public/index.html`, `public/styles.css` | Page markup and styles |
| `public/js/main.js` | Page entry point: wallpaper hooks, frame loop, start-up |
| `public/js/sync.js`, `simulation.js` | Live data from the server; where agents go and how they move |
| `public/js/layout.js`, `scenery.js`, `buildings.js` | Town layout, the static world, and buildings |
| `public/js/ambient.js`, `visitors.js`, `lighting.js` | Weather and traffic, visitors, time of day |
| `public/js/render.js`, `people.js`, `camera.js`, `canvas.js` | Drawing a frame, people, the camera, drawing primitives |
| `public/js/hud.js`, `input.js`, `ui/` | Status bar and chronicle, mouse and keyboard, panels and forms |
| `public/js/config.js`, `state.js`, `utils.js`, `identity.js` | Settings, shared state, helpers, agent names and looks |
| `macos/` | The live-wallpaper app (Swift) |
| `test/` | Log parser and clan summary tests (`npm test`; the hub's are `npm run test:hub`) |

## Licence

MIT — see [LICENSE](LICENSE).
