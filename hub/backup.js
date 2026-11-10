// Copies the hub database to hub/backups/hub-YYYY-MM-DD.db and keeps the last 14 copies.
// Safe while the hub is running. Run nightly, for example from cron:
//   15 3 * * * cd /opt/agent-colony/hub && /usr/bin/node --experimental-sqlite backup.js
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const KEEP = 14;
const dbFile = process.env.DB_FILE || path.join(__dirname, 'hub.db');
const dir = path.join(path.dirname(dbFile), 'backups');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const target = path.join(dir, `hub-${new Date().toISOString().slice(0, 10)}.db`);
fs.rmSync(target, { force: true });

const db = new DatabaseSync(dbFile, { readOnly: true });
db.prepare('VACUUM INTO ?').run(target);
db.close();
fs.chmodSync(target, 0o600);

const old = fs.readdirSync(dir).filter((f) => /^hub-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -KEEP);
for (const file of old) fs.rmSync(path.join(dir, file));
console.log(`Backed up to ${target}`);
