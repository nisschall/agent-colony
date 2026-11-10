// The hub end to end against a fake GitHub: sign-in, clans, linking a Mac, reports and the combined town.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../config');
const { startHub } = require('../server');
const { cleanReport } = require('../town');
const { startFakeGithub } = require('./fake-github');

const SHARED_REPO = 'git:aaaaaaaaaaaaaaaaaaaa';
const ALICE_ONLY = 'local:bbbbbbbbbbbbbbbbbbbb';
const BOB_PRIVATE = 'git:cccccccccccccccccccc';

const USER_IDS = { alice: 'gh:1', bob: 'gh:2', carol: 'gh:3', dave: 'gh:4', erin: 'gh:5' };

let hub;
let github;
let base;
let dataDir;

async function startTestHub(env) {
  const githubUrl = `http://127.0.0.1:${github.address().port}`;
  const config = loadConfig({
    PORT: '0', HOST: '127.0.0.1', DB_FILE: path.join(dataDir, 'hub.db'), DATA_FILE: path.join(dataDir, 'hub-data.json'),
    GITHUB_CLIENT_ID: 'test-id', GITHUB_CLIENT_SECRET: 'test-secret', GITHUB_URL: githubUrl, GITHUB_API_URL: githubUrl,
    HUB_ADMINS: 'alice',
    ...env,
  });
  const server = await startHub(config);
  // Sign-in redirects must point at the real port, which is only known now.
  config.hubUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, url: config.hubUrl };
}

function stopTestHub(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
}

test.before(async () => {
  github = await startFakeGithub();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-hub-'));
  const started = await startTestHub({});
  hub = started.server;
  base = started.url;
});

test.after(async () => {
  await stopTestHub(hub);
  github.close();
});

function cookieValue(response, name) {
  const found = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return found ? found.split(';')[0] : '';
}

async function signIn(login) {
  const start = await fetch(`${base}/auth/login?next=/`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const oauthCookie = cookieValue(start, 'hub_oauth');
  const done = await fetch(`${base}/auth/callback?code=${login}&state=${state}`, { redirect: 'manual', headers: { cookie: oauthCookie } });
  assert.strictEqual(done.status, 302);
  return cookieValue(done, 'hub_session');
}

// Everyone but the admin (alice) waits for approval; most tests just need them let in.
async function signInApproved(login) {
  const session = await signIn(login);
  if (login !== 'alice') {
    const admin = await signIn('alice');
    const approved = await call(admin, 'POST', `/api/admin/users/${USER_IDS[login]}/approve`, {});
    assert.strictEqual(approved.status, 200);
  }
  return session;
}

async function call(auth, method, pathname, body, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (auth.startsWith('acd_')) headers.Authorization = `Bearer ${auth}`;
  else if (auth) headers.cookie = auth;
  const response = await fetch(`${base}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}

async function linkMac(session) {
  const callback = 'http://localhost:4747/clan/linked';
  const response = await fetch(`${base}/link?callback=${encodeURIComponent(callback)}&state=s1`, { redirect: 'manual', headers: { cookie: session } });
  const back = new URL(response.headers.get('location'));
  assert.strictEqual(back.origin + back.pathname, callback);
  assert.strictEqual(back.searchParams.get('state'), 's1');
  const exchanged = await call('', 'POST', '/api/link/exchange', { code: back.searchParams.get('code'), label: 'test Mac' });
  assert.strictEqual(exchanged.status, 200);
  return exchanged.body.token;
}

function report(clanId, projects, agents, events = []) {
  return { version: 1, projects: projects.map((p) => ({ ...p, clans: p.clans || [clanId] })), agents, events };
}

test('a clan sees everyone\'s shared projects, merged by repo, with who is waiting on whom', async () => {
  const alice = await signIn('alice');
  const bob = await signInApproved('bob');
  const created = await call(alice, 'POST', '/api/clans', { name: 'Core team' });
  assert.strictEqual(created.status, 200);
  const clan = created.body.clan;
  const joined = await call(bob, 'POST', '/api/join', { code: clan.inviteCode.toLowerCase() });
  assert.strictEqual(joined.status, 200);

  const aliceMac = await linkMac(alice);
  const bobMac = await linkMac(bob);
  const profile = { complexity: 70, tier: 'tower', codeLines: 90000, languages: ['Java'], features: ['api'] };
  await call(aliceMac, 'POST', '/api/report', report(clan.id, [
    { key: SHARED_REPO, name: 'shop', profile, problems: { failing: [{ kind: 'build', ts: Date.now() }], errorsLastHour: 2 } },
    { key: ALICE_ONLY, name: 'notes' },
  ], [
    { id: 'claude:a1', project: SHARED_REPO, status: 'waiting', waitingSince: 1000, title: 'Fix cart' },
    { id: 'claude:a2', project: ALICE_ONLY, status: 'working' },
  ], [
    { ts: Date.now(), kind: 'build', project: SHARED_REPO, agent: 'claude:a1', text: 'Rebuilt Cart.java (+3 −1)' },
    { ts: Date.now(), kind: 'broke', project: SHARED_REPO, agent: 'claude:a1', text: 'Build failing in shop' },
  ]));
  await call(bobMac, 'POST', '/api/report', report(clan.id, [
    { key: SHARED_REPO, name: 'shop', profile: { ...profile, complexity: 60 } },
    { key: BOB_PRIVATE, name: 'secret', clans: [] },
  ], [
    { id: 'claude:b1', project: SHARED_REPO, status: 'working' },
    { id: 'claude:b2', project: BOB_PRIVATE, status: 'working' },
  ]));

  const { status, body } = await call(bob, 'GET', `/api/clans/${clan.id}/town`);
  assert.strictEqual(status, 200);
  const town = body.town;
  const shop = town.projects.find((p) => p.key === SHARED_REPO);
  assert.deepStrictEqual(shop.members.sort(), ['alice', 'bob']);
  assert.strictEqual(shop.profile.complexity, 70);
  assert.strictEqual(shop.agents, 2);
  assert.strictEqual(shop.waiting, 1);
  assert.deepStrictEqual(shop.failing.map((f) => [f.kind, f.owner]), [['build', 'alice']]);
  assert.ok(town.projects.some((p) => p.key === `alice/${ALICE_ONLY}`), 'a project without a remote stays its owner\'s');
  assert.ok(!town.projects.some((p) => p.name === 'secret'), 'an unshared project is not in the clan town');
  assert.deepStrictEqual(town.agents.map((a) => a.id).sort(), ['alice/claude:a1', 'alice/claude:a2', 'bob/claude:b1']);
  assert.deepStrictEqual(town.waitingOn, [{ login: 'alice', count: 1, oldestSince: 1000 }]);
  assert.deepStrictEqual(town.events.map((e) => [e.owner, e.agent, e.kind]), [['alice', 'alice/claude:a1', 'broke']]);
  const kept = JSON.stringify(town);
  for (const dropped of ['Fix cart', 'Cart.java', 'errorsLastHour']) assert.ok(!kept.includes(dropped), `the town must not hold ${dropped}`);
  assert.ok(town.members.every((m) => m.online));

  const carol = await signInApproved('carol');
  const outsider = await call(carol, 'GET', `/api/clans/${clan.id}/town`);
  assert.strictEqual(outsider.status, 404);

  const left = await call(bob, 'POST', `/api/clans/${clan.id}/leave`, {});
  assert.strictEqual(left.status, 200);
  const after = await call(alice, 'GET', `/api/clans/${clan.id}/town`);
  assert.ok(!after.body.town.agents.some((a) => a.owner === 'bob'), 'someone who left disappears from the town');
});

test('a person can be in several clans and share different projects with each', async () => {
  const alice = await signIn('alice');
  const bob = await signInApproved('bob');
  const work = (await call(alice, 'POST', '/api/clans', { name: 'Work' })).body.clan;
  const friends = (await call(bob, 'POST', '/api/clans', { name: 'Friends' })).body.clan;
  await call(alice, 'POST', '/api/join', { code: friends.inviteCode });
  const me = await call(alice, 'GET', '/api/me');
  assert.ok(['Work', 'Friends'].every((name) => me.body.clans.some((c) => c.name === name)));

  const aliceMac = await linkMac(alice);
  await call(aliceMac, 'POST', '/api/report', report('', [
    { key: SHARED_REPO, name: 'shop', clans: [work.id] },
    { key: ALICE_ONLY, name: 'hobby', clans: [friends.id] },
  ], []));
  const workTown = (await call(alice, 'GET', `/api/clans/${work.id}/town`)).body.town;
  const friendsTown = (await call(bob, 'GET', `/api/clans/${friends.id}/town`)).body.town;
  assert.deepStrictEqual(workTown.projects.map((p) => p.name), ['shop']);
  assert.deepStrictEqual(friendsTown.projects.map((p) => p.name), ['hobby']);
});

test('leaders manage invites and members; others cannot', async () => {
  const alice = await signIn('alice');
  const bob = await signInApproved('bob');
  const clan = (await call(alice, 'POST', '/api/clans', { name: 'Guild' })).body.clan;
  await call(bob, 'POST', '/api/join', { code: clan.inviteCode });
  assert.strictEqual((await call(bob, 'POST', `/api/clans/${clan.id}/invite/reset`, {})).status, 403);
  const reset = await call(alice, 'POST', `/api/clans/${clan.id}/invite/reset`, {});
  assert.notStrictEqual(reset.body.clan.inviteCode, clan.inviteCode);
  const removed = await call(alice, 'POST', `/api/clans/${clan.id}/members/bob/remove`, {});
  assert.strictEqual(removed.status, 200);
  assert.strictEqual((await call(bob, 'GET', `/api/clans/${clan.id}`)).status, 404);
  assert.strictEqual((await call(bob, 'POST', '/api/join', { code: clan.inviteCode })).status, 404, 'the old code no longer works');
});

test('the leader role passes on when the leader leaves', async () => {
  const alice = await signIn('alice');
  const bob = await signInApproved('bob');
  const clan = (await call(alice, 'POST', '/api/clans', { name: 'Relay' })).body.clan;
  await call(bob, 'POST', '/api/join', { code: clan.inviteCode });
  await call(alice, 'POST', `/api/clans/${clan.id}/leave`, {});
  const view = (await call(bob, 'GET', `/api/clans/${clan.id}`)).body.clan;
  assert.deepStrictEqual(view.members.map((m) => [m.login, m.role]), [['bob', 'leader']]);
});

test('requests from other sites, bad link callbacks and revoked Macs are refused', async () => {
  const alice = await signIn('alice');
  const crossSite = await call(alice, 'POST', '/api/clans', { name: 'Evil' }, { Origin: 'https://evil.example' });
  assert.strictEqual(crossSite.status, 403);
  const badCallback = await fetch(`${base}/link?callback=${encodeURIComponent('https://evil.example/clan/linked')}&state=x`, { redirect: 'manual', headers: { cookie: alice } });
  assert.strictEqual(badCallback.status, 400);
  const reused = await call('', 'POST', '/api/link/exchange', { code: 'not-a-code' });
  assert.strictEqual(reused.status, 400);
  const mac = await linkMac(alice);
  assert.strictEqual((await call(mac, 'POST', '/api/devices/self/revoke', {})).status, 200);
  assert.strictEqual((await call(mac, 'POST', '/api/report', report('', [], []))).status, 401);
  assert.strictEqual((await call('', 'GET', '/api/me')).status, 401);
  const unsignedLink = await fetch(`${base}/link?callback=x&state=y`, { redirect: 'manual' });
  assert.ok(unsignedLink.headers.get('location').startsWith('/auth/login?next='));
});

test('reports are trimmed to what the hub accepts', () => {
  const clean = cleanReport({
    projects: [
      { key: SHARED_REPO, name: 'x'.repeat(500), clans: ['mine', 'not-mine'], profile: { complexity: 900, tier: 'castle' } },
      { key: '../../etc', name: 'bad key' },
    ],
    agents: [
      { id: 'a', project: SHARED_REPO, status: 'working' },
      { id: 'b', project: SHARED_REPO, status: 'hacking' },
      { id: 'c', project: 'git:unknownunknownunkn', status: 'working' },
    ],
    events: [{ ts: 1, kind: 'script', project: SHARED_REPO, text: '<b>' }],
  }, new Set(['mine']));
  assert.strictEqual(clean.projects.length, 1);
  assert.strictEqual(clean.projects[0].name.length, 60);
  assert.deepStrictEqual(clean.projects[0].clans, ['mine']);
  assert.deepStrictEqual([clean.projects[0].profile.complexity, clean.projects[0].profile.tier], [100, 'cottage']);
  assert.deepStrictEqual(clean.agents.map((a) => a.id), ['a']);
  assert.strictEqual(clean.events.length, 0);
});

test('someone new waits for approval and can do nothing until an admin lets them in', async () => {
  const erin = await signIn('erin');
  const me = await call(erin, 'GET', '/api/me');
  assert.strictEqual(me.body.user.status, 'pending');
  assert.deepStrictEqual(me.body.admins, ['alice']);
  assert.strictEqual((await call(erin, 'POST', '/api/clans', { name: 'Sneaky' })).status, 403);
  const link = await fetch(`${base}/link?callback=${encodeURIComponent('http://localhost:4747/clan/linked')}&state=s`, { redirect: 'manual', headers: { cookie: erin } });
  assert.strictEqual(link.headers.get('location'), '/?error=waiting');
  assert.strictEqual((await call(erin, 'GET', '/api/admin/users')).status, 403);

  const alice = await signIn('alice');
  const waiting = (await call(alice, 'GET', '/api/admin/users')).body.users.find((u) => u.login === 'erin');
  assert.strictEqual(waiting.status, 'pending');
  // Encoded the way the hub page sends it.
  const approved = await call(alice, 'POST', `/api/admin/users/${encodeURIComponent(USER_IDS.erin)}/approve`, {});
  assert.strictEqual(approved.status, 200);
  assert.strictEqual((await call(erin, 'POST', '/api/clans', { name: 'Erin club' })).status, 200);
});

test('blocking someone signs them out, unlinks their Macs, removes them from clans and keeps them out', async () => {
  const alice = await signIn('alice');
  const bob = await signInApproved('bob');
  const clan = (await call(alice, 'POST', '/api/clans', { name: 'Blockers' })).body.clan;
  await call(bob, 'POST', '/api/join', { code: clan.inviteCode });
  const bobMac = await linkMac(bob);

  const blocked = await call(alice, 'POST', `/api/admin/users/${USER_IDS.bob}/block`, {});
  assert.strictEqual(blocked.status, 200);
  assert.strictEqual((await call(bob, 'GET', '/api/me')).status, 401, 'signed out');
  assert.strictEqual((await call(bobMac, 'POST', '/api/report', report('', [], []))).status, 401, 'Mac unlinked');
  const members = (await call(alice, 'GET', `/api/clans/${clan.id}`)).body.clan.members.map((m) => m.login);
  assert.deepStrictEqual(members, ['alice']);

  const start = await fetch(`${base}/auth/login?next=/`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const again = await fetch(`${base}/auth/callback?code=bob&state=${state}`, { redirect: 'manual', headers: { cookie: cookieValue(start, 'hub_oauth') } });
  assert.strictEqual(again.headers.get('location'), '/?error=blocked');
  assert.strictEqual(cookieValue(again, 'hub_session'), '', 'no session for a blocked account');

  assert.strictEqual((await call(alice, 'POST', `/api/admin/users/${USER_IDS.alice}/block`, {})).status, 400, 'an admin cannot be blocked');
  await call(alice, 'POST', `/api/admin/users/${USER_IDS.bob}/unblock`, {});
  assert.strictEqual((await call(await signIn('bob'), 'GET', '/api/me')).body.user.status, 'approved');
});

test('members of the named GitHub org get in without waiting; others still wait', async () => {
  const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-hub-org-'));
  const { server, url } = await startTestHub({ HUB_AUTO_APPROVE_ORG: 'acme', DB_FILE: path.join(orgDir, 'hub.db'), DATA_FILE: path.join(orgDir, 'none.json') });
  const mainBase = base;
  base = url;
  try {
    const login = await fetch(`${base}/auth/login?next=/`, { redirect: 'manual' });
    assert.strictEqual(new URL(login.headers.get('location')).searchParams.get('scope'), 'read:org');
    assert.strictEqual((await call(await signIn('dave'), 'GET', '/api/me')).body.user.approvedBy, 'org');
    assert.strictEqual((await call(await signIn('erin'), 'GET', '/api/me')).body.user.status, 'pending');
  } finally {
    base = mainBase;
    await stopTestHub(server);
  }
});

test('clans, sessions and linked Macs survive a restart', async () => {
  const alice = await signIn('alice');
  const clan = (await call(alice, 'POST', '/api/clans', { name: 'Durable' })).body.clan;
  const mac = await linkMac(alice);
  await stopTestHub(hub);
  const restarted = await startTestHub({});
  hub = restarted.server;
  base = restarted.url;
  assert.strictEqual((await call(alice, 'GET', `/api/clans/${clan.id}`)).body.clan.name, 'Durable', 'same session still works');
  assert.strictEqual((await call(mac, 'POST', '/api/report', report(clan.id, [], []))).status, 200, 'same Mac token still works');
});

test('an older hub-data.json is imported once, then renamed', async () => {
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-hub-import-'));
  const legacy = path.join(importDir, 'hub-data.json');
  fs.writeFileSync(legacy, JSON.stringify({
    sessionSecret: 'old-secret',
    users: { 'gh:9': { id: 'gh:9', login: 'olduser', name: 'Old', avatarUrl: '' } },
    clans: { c1: { id: 'c1', name: 'Old clan', createdAt: 1, inviteCode: 'OLDCODE123', members: { 'gh:9': { role: 'leader', joinedAt: 1 } } } },
    devices: {},
  }));
  const { server } = await startTestHub({ DB_FILE: path.join(importDir, 'hub.db'), DATA_FILE: legacy });
  await stopTestHub(server);
  assert.ok(fs.existsSync(`${legacy}.imported`) && !fs.existsSync(legacy));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(importDir, 'hub.db'));
  assert.deepStrictEqual({ ...db.prepare('SELECT login, status FROM users').get() }, { login: 'olduser', status: 'approved' });
  assert.strictEqual(db.prepare('SELECT invite_code FROM clans').get().invite_code, 'OLDCODE123');
  db.close();
});

test('the backup script copies the database while the hub runs', () => {
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['--experimental-sqlite', path.join(__dirname, '..', 'backup.js')], { env: { ...process.env, DB_FILE: path.join(dataDir, 'hub.db') }, stdio: 'pipe' });
  const backups = fs.readdirSync(path.join(dataDir, 'backups'));
  assert.strictEqual(backups.length, 1);
  assert.match(backups[0], /^hub-\d{4}-\d{2}-\d{2}\.db$/);
});

test('shared summaries, questions and update posts reach the town, trimmed', () => {
  const clean = cleanReport({
    projects: [{ key: SHARED_REPO, name: 'shop', clans: ['mine'] }],
    agents: [
      { id: 'a', project: SHARED_REPO, status: 'waiting', ask: 'q'.repeat(500), summary: { text: 'Did the thing.', ts: 5 } },
      { id: 'b', project: SHARED_REPO, status: 'working', ask: 'not waiting, so dropped' },
    ],
    events: ['update', 'broke', 'fixed'].map((kind) => ({ ts: 1, kind, project: SHARED_REPO, agent: 'a', text: `${kind} text` })),
  }, new Set(['mine']));
  assert.deepStrictEqual(clean.agents[0].summary, { text: 'Did the thing.', ts: 5 });
  assert.strictEqual(clean.agents[0].ask.length, 200);
  assert.strictEqual(clean.agents[1].ask, '');
  assert.deepStrictEqual(clean.events.map((e) => e.kind), ['update', 'broke', 'fixed']);
});
