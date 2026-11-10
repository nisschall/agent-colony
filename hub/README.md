# Agent Colony hub

The shared side of Agent Colony: people sign in with GitHub, form clans, link their Macs, and each clan gets one combined town of everyone's shared projects and agents. A person can be in as many clans as they like, and choose which projects each clan sees.

Node 22.5 or later, no other dependencies: the database is SQLite, built into Node. The hub draws each clan's town with the colony's own town page (`../public`), so deploy this repository and start the hub from `hub/`. (Your Macs' colonies don't need Node 22; only the hub does.)

## Pages

- **`/`**: sign in with GitHub; your clans, with their members and invite code (leaders can remove members and make a new code); create a clan; join one with a code; and your linked Macs, which you can unlink. An invite link (`/?join=CODE`) fills in the code. Hub admins also see **People**: who is waiting, who is in, and who is blocked.
- **`/clans/:id`**: the clan's town, live. Everyone's shared projects are buildings (one per repo, "👥 2" when two members work on it), workers carry their owner's name, the Review Office sign says who is waiting on whom ("🙋 3 WAITING · alice 2 · bob 1"), and 👥 lists the members. It is watch-only: clicking an agent shows its status, task and current tool, never its conversation.

## Who can use the hub

Signing in with GitHub is not enough on its own: only people let in can use the hub.

- **Hub admins** are the GitHub logins in `HUB_ADMINS`. They are always let in, and only they can let people in or block them.
- **Everyone else waits** after signing in. They see "Waiting for approval" and can't create or join clans, link a Mac or open a clan town. An admin clicks **Let in** under **People** on the hub page, and the waiting page moves on by itself.
- **Org members can skip the wait** if you set `HUB_AUTO_APPROVE_ORG` to a GitHub organisation. GitHub's sign-in screen then asks each person once to let the hub read their org membership (the `read:org` permission). Someone let in by the org goes back to waiting if they have left it by their next sign-in; someone an admin let in stays in until blocked.
- **Block** (two clicks) takes everything away at once: the person is signed out everywhere, every Mac they linked is unlinked, they are removed from every clan (the longest-standing member takes over as leader), and they can't sign in again. **Unblock** lets them back in; they rejoin clans with an invite code and link their Macs again. Admins can't be blocked: remove them from `HUB_ADMINS` first.

## What members share

Each linked Mac sends the hub a short summary every 5 seconds, for the projects its owner chose to share and nothing else:

- each shared project: its name, a hash of its git remote (so the same repo becomes one building), its size and complexity, failing builds or tests, and how many tool errors it had in the last hour;
- each agent in those projects: its status, session title, model, and current tool, with a file name but no folder (for example `Edit: Cart.java`, or just `Bash`);
- recent activity in those projects, for example `Rebuilt Cart.java (+3 −1)` or `hit an error`.

Never sent: transcripts, prompts, code, shell commands, what an agent is asking you, error text, folder paths or costs.

## What the hub stores

Live reports are kept in memory only; after a restart, towns fill again within 5 seconds. Everything else is in one SQLite file, `hub/hub.db`:

- people: GitHub id, login, name, avatar, whether they are waiting, let in or blocked, and how they were let in;
- clans, their invite codes, and who is in each one (with their role);
- linked Macs: a name, when they were linked and last seen, and a hash of each Mac's token (never the token);
- the secret that signs sign-in cookies.

The GitHub access token is used during sign-in only and never stored. Every change is on disk before the hub answers, and a crash or power cut can't corrupt the file (write-ahead log, full sync). The database and its `-wal`/`-shm` files are readable only by the user the hub runs as.

A hub that ran before the database existed kept its data in `hub-data.json`. On first start the hub imports it (everyone in it counts as let in) and renames it to `hub-data.json.imported`.

## Settings

Copy `.env.example` to `.env` in `hub/` and fill it in; `npm start` reads it. Never commit `.env`.

| Setting | Default | What it is |
|---|---|---|
| `HUB_URL` | `http://localhost:PORT` | The address people open; used for the GitHub callback and secure cookies |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | From your GitHub OAuth App |
| `HUB_ADMINS` | none | GitHub logins, comma-separated, that run the hub |
| `HUB_AUTO_APPROVE_ORG` | none | A GitHub organisation whose members get in without waiting |
| `PORT`, `HOST` | `4800`, `0.0.0.0` | Where the hub listens; behind Caddy or nginx use `HOST=127.0.0.1` |
| `DB_FILE` | `hub/hub.db` | The SQLite database |
| `DATA_FILE` | `hub/hub-data.json` | An older hub's data file to import once |
| `PUBLIC_DIR` | `../public` | The colony's town page, used for clan towns |
| `GITHUB_URL`, `GITHUB_API_URL` | `https://github.com`, `https://api.github.com` | For GitHub Enterprise |

## Set up on a server

These steps are for an Ubuntu server on Oracle Cloud with the public IP `140.245.26.67` and no domain. The hub's address is then **`https://140-245-26-67.sslip.io`**: sslip.io names point at the IP inside them, and Caddy gets a free HTTPS certificate for it. For another IP, change the name in `deploy/Caddyfile` and `HUB_URL`.

1. **Create the GitHub OAuth App** under GitHub → Settings → Developer settings → OAuth Apps → New OAuth App (or under your organisation's settings):
   - Homepage URL: `https://140-245-26-67.sslip.io`
   - Authorization callback URL: `https://140-245-26-67.sslip.io/auth/callback`

   Copy the client ID and generate a client secret.
2. **Open ports 80 and 443.** In the Oracle Cloud console, open the instance's subnet → Security List → Add Ingress Rules: source `0.0.0.0/0`, TCP, destination ports `80` and `443`. Oracle's Ubuntu images also block them on the server itself:

   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   ```

   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   ```

   ```bash
   sudo netfilter-persistent save
   ```

   Port 4800 stays closed: the hub only listens on `127.0.0.1`.
3. **Install Node 22:**

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
   ```

4. **Add a user for the hub and the code:**

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin colony
   ```

   ```bash
   sudo git clone https://github.com/nisschall/agent-colony.git /opt/agent-colony && sudo chown -R colony:colony /opt/agent-colony
   ```

5. **Fill in the settings**: copy `.env.example` to `.env`, then set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `HUB_ADMINS` (your GitHub login). `HUB_URL`, `HOST` and `PORT` are already right for this server.

   ```bash
   sudo -u colony cp /opt/agent-colony/hub/.env.example /opt/agent-colony/hub/.env && sudo chmod 600 /opt/agent-colony/hub/.env
   ```

   ```bash
   sudo -u colony nano /opt/agent-colony/hub/.env
   ```

6. **Start the hub as a service** (it restarts by itself and after a reboot):

   ```bash
   sudo cp /opt/agent-colony/hub/deploy/agent-colony-hub.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now agent-colony-hub
   ```

   Its log: `journalctl -u agent-colony-hub -f`.
7. **Put HTTPS in front with Caddy.** Install Caddy from its Ubuntu package (instructions at caddyserver.com/docs/install), then:

   ```bash
   sudo cp /opt/agent-colony/hub/deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
   ```

   If nginx already serves other sites on this server, skip Caddy: add a `server` block for `140-245-26-67.sslip.io` that proxies to `http://127.0.0.1:4800` (with `proxy_buffering off` so the live town streams), and get its certificate with certbot.
8. **Back up nightly.** `backup.js` copies the database to `hub/backups/hub-YYYY-MM-DD.db` while the hub runs and keeps the last 14 copies. Add it to the hub user's crontab (`sudo crontab -u colony -e`):

   ```
   15 3 * * * cd /opt/agent-colony/hub && /usr/bin/node --experimental-sqlite backup.js
   ```

   To restore, stop the hub, copy a backup over `hub.db` (and delete `hub.db-wal` and `hub.db-shm`), and start it again.
9. **Sign in** at `https://140-245-26-67.sslip.io` with the GitHub account in `HUB_ADMINS`, create a clan, and share its invite link. Teammates enter the same address in their town's 🛡 panel.

To update the hub later:

```bash
cd /opt/agent-colony && sudo -u colony git pull && sudo systemctl restart agent-colony-hub
```

## Try it on one Mac without GitHub

`test/fake-github.js` stands in for GitHub and signs you in as `alice`:

```bash
cd hub && PORT=4801 node test/fake-github.js
```

```bash
cd hub && PORT=4800 HUB_ADMINS=alice GITHUB_CLIENT_ID=demo GITHUB_CLIENT_SECRET=demo GITHUB_URL=http://127.0.0.1:4801 GITHUB_API_URL=http://127.0.0.1:4801 npm start
```

Then link your colony to `http://localhost:4800`.

## How a Mac is linked

1. The colony asks you for the hub address and sends your browser to `/link`, with its own one-time `state`.
2. You sign in with GitHub if you haven't already (and must be let in). The hub sends the browser back to the colony on `localhost` with a single-use code that expires in 2 minutes. It refuses any other callback address.
3. The colony checks its `state`, trades the code for a device token, and keeps that token in `clan.json` (only readable by you). Unlinking revokes the token on the hub. You can also revoke any linked Mac from the hub, and blocking someone revokes all of theirs.

## API

Browser calls use the session cookie; linked Macs use `Authorization: Bearer <device token>`. POST bodies are JSON, and the hub refuses posts from other sites. Apart from `/api/me` and signing out, every call needs someone who has been let in.

| Call | Who | What |
|---|---|---|
| `GET /auth/login?next=/path`, `GET /auth/callback`, `POST /auth/logout` | browser | GitHub sign-in |
| `GET /link?callback=…&state=…` | browser | Start linking a Mac |
| `POST /api/link/exchange` `{code, label}` | colony | Trade a link code for a device token |
| `GET /api/me` | either | You (including whether you are waiting), your clans, and the hub admins |
| `POST /api/report` | colony | This Mac's summary |
| `POST /api/devices/self/revoke` | colony | Unlink this Mac |
| `GET /api/devices`, `POST /api/devices/:id/revoke` | browser | Your linked Macs |
| `POST /api/clans` `{name}` | browser | Create a clan (you lead it) |
| `POST /api/join` `{code}` | browser | Join with an invite code |
| `GET /api/clans/:id` | member | The clan, its members and invite code |
| `GET /api/clans/:id/town` | member | The combined town |
| `GET /api/clans/:id/stream` | member | The combined town, live (server-sent events, every 2 s) |
| `POST /api/clans/:id/leave` | member | Leave; the longest-standing member becomes leader, and an empty clan is deleted |
| `POST /api/clans/:id/invite/reset` | leader | New invite code; the old one stops working |
| `POST /api/clans/:id/members/:login/remove` | leader | Remove someone |
| `GET /api/admin/users` | admin | Everyone who has signed in, with their status, clans and Macs |
| `POST /api/admin/users/:id/approve`, `…/unblock`, `…/block` | admin | Let someone in, let them back in, or block them |

## Tests

```bash
npm test
```

Run them with Node 22. They run the whole flow against the fake GitHub: sign-in, waiting for approval, letting in and blocking, org auto-approve, clans, linking, reports from two members, the merged town, the refusals, surviving a restart, importing `hub-data.json`, and the backup script.
