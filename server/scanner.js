// Finds session logs and tails them for new lines.
const fs = require('fs');
const path = require('path');
const { agents, getAgent } = require('./agents');
const { CLAUDE_DIR, CODEX_DIR, HISTORY_DAYS, MIN } = require('./config');
const { handleClaudeLine } = require('./logs/claude');
const { handleCodexLine } = require('./logs/codex');

const files = new Map();

function readNewBytes(file) {
  const state = files.get(file);
  let stat;
  try { stat = fs.statSync(file); } catch { return; }
  if (stat.size < state.offset) state.offset = 0;
  if (stat.size === state.offset) return;
  const fd = fs.openSync(file, 'r');
  const chunkSize = 8 * 1024 * 1024;
  const buffer = Buffer.alloc(chunkSize);
  try {
    while (state.offset < stat.size) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, state.offset);
      if (bytesRead <= 0) break;
      state.offset += bytesRead;
      const text = state.partial + buffer.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      state.partial = lines.pop();
      for (const line of lines) {
        if (line) state.handler(line);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir, out, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 5) walk(full, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

function registerFile(file) {
  if (files.has(file)) return;
  let stat;
  try { stat = fs.statSync(file); } catch { return; }
  if (Date.now() - stat.mtimeMs > HISTORY_DAYS * 24 * 60 * MIN) return;

  let agent;
  if (file.startsWith(CODEX_DIR)) {
    agent = getAgent(`codex:${path.basename(file, '.jsonl')}`, 'codex');
  } else if (file.includes(`${path.sep}subagents${path.sep}`)) {
    const sessionDir = path.dirname(path.dirname(file));
    agent = getAgent(`sub:${path.basename(file, '.jsonl')}`, 'subagent');
    agent.parentId = `claude:${path.basename(sessionDir)}`;
    try {
      const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      agent.title = meta.description || meta.agentType || 'helper';
    } catch { /* meta file is optional */ }
  } else {
    agent = getAgent(`claude:${path.basename(file, '.jsonl')}`, 'claude');
  }
  const handler = agent.kind === 'codex' ? (line) => handleCodexLine(agent, line) : (line) => handleClaudeLine(agent, line);
  files.set(file, { offset: 0, partial: '', handler });
}

function discover() {
  const found = [];
  walk(CLAUDE_DIR, found);
  walk(CODEX_DIR, found);
  found.forEach(registerFile);
}

function poll() {
  for (const file of files.keys()) readNewBytes(file);
  for (const agent of agents.values()) {
    if (agent.kind === 'subagent' && agent.project === 'unknown') {
      const parent = agents.get(agent.parentId);
      if (parent) agent.project = parent.project;
    }
  }
}

module.exports = { files, discover, poll };
