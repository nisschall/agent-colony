// What this Mac sends to a clan hub: only shared projects, and nothing private from them.
const test = require('node:test');
const assert = require('node:assert');
const { buildReport, normalizeRemote } = require('../server/clan');

test('clone URLs of the same repo normalize alike, without credentials', () => {
  const same = [
    'git@github.com:Acme/Shop.git',
    'https://github.com/acme/shop',
    'https://user:ghp_secret@github.com/Acme/Shop.git',
    'ssh://git@github.com/acme/shop.git/',
  ];
  for (const url of same) assert.strictEqual(normalizeRemote(url), 'github.com/acme/shop');
  assert.strictEqual(normalizeRemote(''), '');
});

test('the report holds only shared projects and leaves out commands, questions, paths and error text', () => {
  const now = Date.now();
  const snap = {
    projects: [
      { name: 'shop', path: '/Users/me/code/shop', lastTs: now, profile: { complexity: 50 }, problems: { failing: [{ kind: 'build', ok: false, ts: now, command: 'cd /Users/me/code/shop && ./mvnw compile' }], errorsLastHour: 3 } },
      { name: 'diary', path: '/Users/me/diary', lastTs: now, profile: null, problems: { failing: [], errorsLastHour: 0 } },
    ],
    agents: [
      { id: 'claude:1', kind: 'claude', workProject: 'shop', status: 'waiting', waitingSince: now, waitingAsk: 'Use the prod password?', lastAction: 'Bash: export TOKEN=abc && deploy', title: 'Checkout', model: 'opus', lastTs: now },
      { id: 'claude:2', kind: 'claude', workProject: 'shop', status: 'working', lastAction: 'Edit: /Users/me/code/shop/src/Cart.java', lastTs: now },
      { id: 'claude:3', kind: 'claude', workProject: 'diary', status: 'working', lastAction: 'Write: /Users/me/diary/today.md', lastTs: now },
    ],
    events: [
      { ts: now, kind: 'error', project: 'shop', agentId: 'claude:1', text: 'tripped: password=hunter2 rejected' },
      { ts: now, kind: 'build', project: 'shop', agentId: 'claude:2', text: 'Rebuilt Cart.java (+3 −1)' },
      { ts: now, kind: 'build', project: 'shop', agentId: 'claude:1', text: 'finished: moved the API keys into vault' },
      { ts: now, kind: 'waiting', project: 'shop', agentId: 'claude:1', text: 'is waiting for your review: Use the prod password?' },
      { ts: now, kind: 'build', project: 'diary', agentId: 'claude:3', text: 'Built today.md (+10 −0)' },
    ],
  };
  const report = buildReport(snap, { shop: ['clan1'] }, () => 'git:aaaaaaaaaaaaaaaaaaaa');
  assert.deepStrictEqual(report.projects.map((p) => p.name), ['shop']);
  assert.deepStrictEqual(report.agents.map((a) => a.activity), ['Bash', 'Edit: Cart.java']);
  assert.deepStrictEqual(report.events.map((e) => e.text), ['hit an error', 'Rebuilt Cart.java (+3 −1)', 'finished a task', 'is waiting for review']);
  const sent = JSON.stringify(report);
  for (const secret of ['/Users/', 'TOKEN', 'password', 'hunter2', 'vault', 'mvnw', 'diary', 'today.md']) {
    assert.ok(!sent.includes(secret), `report must not contain ${secret}`);
  }
});

test('agents\' summaries and questions are shared only when the member turns on sharing updates', () => {
  const now = Date.now();
  const snap = {
    projects: [{ name: 'shop', path: '/Users/me/code/shop', lastTs: now, profile: null, problems: { failing: [], errorsLastHour: 0 } }],
    agents: [{ id: 'claude:1', kind: 'claude', workProject: 'shop', status: 'waiting', waitingSince: now, waitingAsk: 'Which repository?', lastAction: 'Bash: ls', lastTs: now, summary: { ts: now, text: 'Drafted both options.' } }],
    events: [
      { ts: now, kind: 'update', project: 'shop', agentId: 'claude:1', text: 'Drafted both options.' },
      { ts: now, kind: 'waiting', project: 'shop', agentId: 'claude:1', text: 'is waiting for your review: Which repository?' },
      { ts: now, kind: 'broke', project: 'shop', agentId: 'claude:1', text: 'Build failing in shop' },
    ],
  };
  const key = () => 'git:aaaaaaaaaaaaaaaaaaaa';
  const off = buildReport(snap, { shop: ['c1'] }, key);
  assert.deepStrictEqual([off.agents[0].summary, off.agents[0].ask], [null, '']);
  assert.deepStrictEqual(off.events.map((e) => e.text), ['is waiting for review', 'Build failing in shop']);
  const on = buildReport(snap, { shop: ['c1'] }, key, true);
  assert.deepStrictEqual([on.agents[0].summary.text, on.agents[0].ask], ['Drafted both options.', 'Which repository?']);
  assert.deepStrictEqual(on.events.map((e) => e.text), ['Drafted both options.', 'Which repository?', 'Build failing in shop']);
});
