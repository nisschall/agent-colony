// What the hub keeps between restarts, in one SQLite file: users (and whether they may use the hub), clans,
// memberships and linked Macs. Live agent reports are not stored; they are in memory only (see town.js).
const crypto = require('crypto');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { ApiError } = require('./api-error');

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_LENGTH = 10;
const CLAN_NAME = /^[\p{L}\p{N} _.'-]{2,40}$/u;
// Each Mac reports every 5 seconds; writing "last seen" once a minute is plenty.
const LAST_SEEN_EVERY_MS = 60_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'blocked')),
    approved_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_login INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS clans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    clan_id TEXT NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('leader', 'member')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (clan_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS memberships_by_user ON memberships(user_id);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS devices_by_user ON devices(user_id);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function randomId() {
  return crypto.randomBytes(9).toString('base64url');
}

function inviteCode() {
  const bytes = crypto.randomBytes(INVITE_LENGTH);
  return [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function openDatabase(dbFile) {
  // SQLite creates its -wal and -shm files later, and they hold the same data: keep every file it makes private.
  process.umask(0o077);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbFile + suffix)) fs.chmodSync(dbFile + suffix, 0o600);
  }
  const db = new DatabaseSync(dbFile);
  // WAL with full sync: every change is on disk before the call returns, and a crash can't corrupt the file.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  fs.chmodSync(dbFile, 0o600);
  return db;
}

function createStore(dbFile) {
  const db = openDatabase(dbFile);
  const sql = (text) => db.prepare(text);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function sessionSecret() {
    const row = sql("SELECT value FROM settings WHERE key = 'session_secret'").get();
    if (row) return row.value;
    const secret = crypto.randomBytes(32).toString('hex');
    sql("INSERT INTO settings (key, value) VALUES ('session_secret', ?)").run(secret);
    return secret;
  }

  function toUser(row) {
    if (!row) return null;
    return {
      id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url,
      status: row.status, approvedBy: row.approved_by, createdAt: row.created_at, lastLogin: row.last_login,
    };
  }

  // Clans keep the shape the rest of the hub uses: members keyed by user id.
  function toClan(row) {
    if (!row) return null;
    const members = {};
    for (const m of sql('SELECT user_id, role, joined_at FROM memberships WHERE clan_id = ?').all(row.id)) {
      members[m.user_id] = { role: m.role, joinedAt: m.joined_at };
    }
    return { id: row.id, name: row.name, createdAt: row.created_at, inviteCode: row.invite_code, members };
  }

  // GitHub profile details refresh on every sign-in; whether someone may use the hub is decided by auth.js.
  function upsertUser(github) {
    const id = `gh:${github.id}`;
    const now = Date.now();
    sql(`INSERT INTO users (id, login, name, avatar_url, created_at, last_login) VALUES (:id, :login, :name, :avatar, :now, :now)
      ON CONFLICT(id) DO UPDATE SET login = :login, name = :name, avatar_url = :avatar, last_login = :now`)
      .run({ id, login: github.login, name: github.name || '', avatar: github.avatar_url || '', now });
    return userOf(id);
  }

  function userOf(id) {
    return toUser(sql('SELECT * FROM users WHERE id = ?').get(id));
  }

  function listUsers() {
    return sql(`SELECT u.*, (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS clans,
      (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS macs FROM users u ORDER BY u.created_at`).all()
      .map((row) => ({ ...toUser(row), clans: row.clans, macs: row.macs }));
  }

  function clanRow(id) {
    return sql('SELECT * FROM clans WHERE id = ?').get(id);
  }

  function clansOf(userId) {
    return sql('SELECT c.* FROM clans c JOIN memberships m ON m.clan_id = c.id WHERE m.user_id = ? ORDER BY c.created_at').all(userId).map(toClan);
  }

  function memberClan(clanId, userId) {
    const clan = toClan(clanRow(clanId));
    if (!clan || !clan.members[userId]) throw new ApiError(404, 'No such clan, or you are not in it.');
    return clan;
  }

  function leaderClan(clanId, userId) {
    const clan = memberClan(clanId, userId);
    if (clan.members[userId].role !== 'leader') throw new ApiError(403, 'Only the clan leader can do that.');
    return clan;
  }

  function createClan(userId, rawName) {
    const name = String(rawName || '').trim();
    if (!CLAN_NAME.test(name)) throw new ApiError(400, 'Give the clan a name of 2 to 40 letters, numbers or spaces.');
    const id = randomId();
    const now = Date.now();
    transaction(() => {
      sql('INSERT INTO clans (id, name, invite_code, created_at) VALUES (?, ?, ?, ?)').run(id, name, inviteCode(), now);
      sql("INSERT INTO memberships (clan_id, user_id, role, joined_at) VALUES (?, ?, 'leader', ?)").run(id, userId, now);
    });
    return toClan(clanRow(id));
  }

  function joinClan(userId, rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    const row = sql('SELECT * FROM clans WHERE invite_code = ?').get(code);
    if (!row) throw new ApiError(404, 'That invite code is not valid. Ask the clan leader for a new one.');
    sql("INSERT OR IGNORE INTO memberships (clan_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(row.id, userId, Date.now());
    return toClan(row);
  }

  // The longest-standing member takes over when the leader leaves; an empty clan is deleted.
  // Runs inside the caller's transaction.
  function dropMembership(clanId, userId) {
    const leaving = sql('SELECT role FROM memberships WHERE clan_id = ? AND user_id = ?').get(clanId, userId);
    sql('DELETE FROM memberships WHERE clan_id = ? AND user_id = ?').run(clanId, userId);
    const next = sql('SELECT user_id FROM memberships WHERE clan_id = ? ORDER BY joined_at LIMIT 1').get(clanId);
    if (!next) sql('DELETE FROM clans WHERE id = ?').run(clanId);
    else if (leaving?.role === 'leader') sql("UPDATE memberships SET role = 'leader' WHERE clan_id = ? AND user_id = ?").run(clanId, next.user_id);
  }

  function removeMember(clanId, userId) {
    transaction(() => dropMembership(clanId, userId));
  }

  function leaveClan(clanId, userId) {
    memberClan(clanId, userId);
    removeMember(clanId, userId);
  }

  function kickMember(clanId, leaderId, memberId) {
    const clan = leaderClan(clanId, leaderId);
    if (memberId === leaderId) throw new ApiError(400, 'Leave the clan instead of removing yourself.');
    if (!clan.members[memberId]) throw new ApiError(404, 'That person is not in the clan.');
    removeMember(clanId, memberId);
  }

  function resetInvite(clanId, userId) {
    leaderClan(clanId, userId);
    sql('UPDATE clans SET invite_code = ? WHERE id = ?').run(inviteCode(), clanId);
    return toClan(clanRow(clanId));
  }

  function setUserStatus(userId, status, approvedBy = '') {
    sql('UPDATE users SET status = ?, approved_by = ? WHERE id = ?').run(status, approvedBy, userId);
  }

  // Blocking takes everything away at once: clans (handing leadership on) and every linked Mac.
  function blockUser(userId) {
    transaction(() => {
      for (const { clan_id: clanId } of sql('SELECT clan_id FROM memberships WHERE user_id = ?').all(userId)) dropMembership(clanId, userId);
      sql('DELETE FROM devices WHERE user_id = ?').run(userId);
      setUserStatus(userId, 'blocked');
    });
  }

  function addDevice(userId, rawLabel) {
    const token = `acd_${crypto.randomBytes(32).toString('base64url')}`;
    const device = { id: randomId(), userId, label: String(rawLabel || 'A Mac').slice(0, 60), createdAt: Date.now(), lastSeen: 0 };
    sql('INSERT INTO devices (id, user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(device.id, userId, hashToken(token), device.label, device.createdAt);
    return { token, device };
  }

  function toDevice(row) {
    return row ? { id: row.id, userId: row.user_id, label: row.label, createdAt: row.created_at, lastSeen: row.last_seen } : null;
  }

  function deviceByToken(token) {
    if (!token) return null;
    return toDevice(sql('SELECT * FROM devices WHERE token_hash = ?').get(hashToken(token)));
  }

  function devicesOf(userId) {
    return sql('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').all(userId).map(toDevice);
  }

  function revokeDevice(userId, deviceId) {
    const { changes } = sql('DELETE FROM devices WHERE id = ? AND user_id = ?').run(deviceId, userId);
    if (!changes) throw new ApiError(404, 'No such linked Mac.');
  }

  function touchDevice(device) {
    const now = Date.now();
    if (now - device.lastSeen < LAST_SEEN_EVERY_MS) return;
    sql('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, device.id);
  }

  // A hub started before the database existed kept its data in a JSON file; bring it over once.
  function importJson(jsonFile) {
    if (!fs.existsSync(jsonFile) || sql('SELECT COUNT(*) AS n FROM users').get().n) return false;
    const old = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    transaction(() => {
      for (const u of Object.values(old.users || {})) {
        sql("INSERT INTO users (id, login, name, avatar_url, status, approved_by, created_at) VALUES (?, ?, ?, ?, 'approved', 'import', ?)")
          .run(u.id, u.login, u.name || '', u.avatarUrl || '', Date.now());
      }
      for (const c of Object.values(old.clans || {})) {
        sql('INSERT INTO clans (id, name, invite_code, created_at) VALUES (?, ?, ?, ?)').run(c.id, c.name, c.inviteCode, c.createdAt);
        for (const [userId, m] of Object.entries(c.members || {})) {
          sql('INSERT INTO memberships (clan_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(c.id, userId, m.role, m.joinedAt);
        }
      }
      for (const [tokenHash, d] of Object.entries(old.devices || {})) {
        sql('INSERT INTO devices (id, user_id, token_hash, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
          .run(d.id, d.userId, tokenHash, d.label, d.createdAt, d.lastSeen || 0);
      }
      if (old.sessionSecret) sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('session_secret', ?)").run(old.sessionSecret);
    });
    fs.renameSync(jsonFile, `${jsonFile}.imported`);
    return true;
  }

  return {
    sessionSecret, importJson,
    upsertUser, userOf, listUsers, setUserStatus, blockUser,
    clansOf, memberClan, createClan, joinClan, leaveClan, kickMember, resetInvite,
    addDevice, deviceByToken, devicesOf, revokeDevice, touchDevice,
    close: () => db.close(),
  };
}

module.exports = { createStore };
