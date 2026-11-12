// Which project an edit, a folder or a clone belongs to.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('an edit made from a plain folder of repos counts toward the repo it changed', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'colony-home-')));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { creditedProject } = require('../server/agents');
    const workspace = path.join(home, 'work');
    const repo = path.join(workspace, 'billing');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'));
    assert.strictEqual(creditedProject({ cwd: workspace }, path.join(repo, 'src', 'Invoice.java')), 'billing');
    assert.strictEqual(creditedProject({ cwd: repo }, path.join(repo, 'src', 'Invoice.java')), '');
    assert.strictEqual(creditedProject({ cwd: workspace }, path.join(workspace, 'notes.md')), '');
  } finally {
    process.env.HOME = previousHome;
  }
});

test('folders cloned from the same repo become one building, named after the shortest folder name', () => {
  const { execFileSync } = require('child_process');
  const { mergeClones } = require('../server/snapshot');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-clones-'));
  const clone = (folder, remote) => {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir);
    execFileSync('git', ['init', '-q', dir]);
    if (remote) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
    return dir;
  };
  const entry = (name, dir, lines, waitingIds = []) => ({
    name, path: dir, lines, linesToday: 0, cost: 1, agents: 1, active: 1, errors: 0, lastTs: lines, weekScore: 2, layers: ['ui'], waitingIds,
  });
  const projects = new Map([
    ['audit-app-before', entry('audit-app-before', clone('audit-app-before', 'git@ssh.bitbucket.org:acme/ucf.git'), 30, ['a1'])],
    ['audit-app', entry('audit-app', clone('audit-app', 'https://me@bitbucket.org/acme/ucf.git'), 10)],
    ['shop', entry('shop', clone('shop', 'git@github.com:acme/shop.git'), 5)],
    ['notes', entry('notes', clone('notes', ''), 1)],
  ]);
  const renamed = mergeClones(projects);
  assert.deepStrictEqual([...projects.keys()].sort(), ['audit-app', 'notes', 'shop']);
  assert.deepStrictEqual([...renamed], [['audit-app-before', 'audit-app']]);
  const merged = projects.get('audit-app');
  assert.deepStrictEqual([merged.lines, merged.agents, merged.lastTs, merged.waitingIds, merged.folders], [40, 2, 30, ['a1'], ['audit-app', 'audit-app-before']]);
});
