// Sample transcript lines run through the log parsers. Claude Code and Codex log formats are not public APIs,
// so these tests are the first place a format change shows up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { events, getAgent, statusOf, stressOf } = require('../server/agents');
const { problemsOf } = require('../server/checks');
const { conversationOf } = require('../server/conversation');
const { handleClaudeLine } = require('../server/logs/claude');
const { handleCodexLine } = require('../server/logs/codex');
const { priceFor } = require('../server/pricing');

const MODEL = 'claude-sonnet-4-5';
let clock = Date.now() - 10 * 60_000;
let nextId = 0;

function at() {
  clock += 1000;
  return new Date(clock).toISOString();
}

function projectFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'colony-test-'));
}

function newAgent() {
  nextId += 1;
  const agent = getAgent(`claude:test-${nextId}`, 'claude');
  const cwd = projectFolder();
  feed(agent, { type: 'user', cwd, timestamp: at(), origin: { kind: 'human' }, message: { role: 'user', content: 'Fix the login page' } });
  return { agent, cwd };
}

function feed(agent, record) {
  handleClaudeLine(agent, JSON.stringify(record));
}

// Real assistant lines always carry usage, and the parser skips lines that have neither usage nor tools.
function assistant(agent, content, extra = {}) {
  const usage = { input_tokens: 10, output_tokens: 10 };
  feed(agent, { type: 'assistant', timestamp: at(), message: { id: `msg-${clock}`, model: MODEL, usage, content, ...extra } });
}

function toolResult(agent, toolUseId, content, isError = false) {
  feed(agent, { type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } });
}

function bash(agent, id, command) {
  assistant(agent, [{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
}

function statusNow(agent) {
  const now = Date.now();
  return statusOf(agent, now, stressOf(agent, now));
}

test('a human message sets the project from cwd', () => {
  const { agent, cwd } = newAgent();
  assert.strictEqual(agent.project, path.basename(cwd));
  assert.strictEqual(agent.humanMsgs, 1);
});

test('usage is priced once per message id', () => {
  const { agent } = newAgent();
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 };
  const record = { type: 'assistant', timestamp: at(), message: { id: 'msg-dup', model: MODEL, usage, content: [{ type: 'text', text: 'Working on it.' }] } };
  feed(agent, record);
  feed(agent, record);
  const price = priceFor(MODEL);
  const expected = (1000 * price.input + 500 * price.output + 2000 * price.cacheRead) / 1e6;
  assert.ok(Math.abs(agent.cost - expected) < 1e-9);
  assert.strictEqual(agent.tokens.output, 500);
});

test('edits and writes count lines', () => {
  const { agent, cwd } = newAgent();
  assistant(agent, [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: path.join(cwd, 'a.js'), old_string: 'x', new_string: 'y\nz' } }]);
  assistant(agent, [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: path.join(cwd, 'b.js'), content: '1\n2\n3' } }]);
  assert.strictEqual(agent.linesAdded, 5);
  assert.strictEqual(agent.linesRemoved, 1);
  assert.strictEqual(agent.edits, 2);
});

test('AskUserQuestion waits on you until you reply', () => {
  const { agent } = newAgent();
  assistant(agent, [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which database?' }] } }]);
  assert.strictEqual(statusNow(agent), 'waiting');
  assert.strictEqual(agent.waitingAsk, 'Which database?');
  feed(agent, { type: 'user', timestamp: at(), origin: { kind: 'human' }, message: { role: 'user', content: 'Postgres' } });
  assert.notStrictEqual(statusNow(agent), 'waiting');
});

test('a turn ending on a question waits; one ending on a statement does not', () => {
  const { agent } = newAgent();
  assistant(agent, [{ type: 'text', text: 'Done. Shall I also update the tests?' }], { stop_reason: 'end_turn' });
  assert.strictEqual(agent.waiting, true);
  assert.strictEqual(agent.waitingAsk, 'Shall I also update the tests?');
  feed(agent, { type: 'user', timestamp: at(), origin: { kind: 'human' }, message: { role: 'user', content: 'yes' } });
  assistant(agent, [{ type: 'text', text: 'Tests updated.' }], { stop_reason: 'end_turn' });
  assert.strictEqual(agent.waiting, false);
});

test('a question followed by a list of options still waits on you', () => {
  const { agent } = newAgent();
  const text = 'Both drafts are ready.\n\nSo I need one answer before writing Draft 7: **which app repository do SaaS tenants run?**\n\n'
    + '1. One shared repository for everyone (`cybervisible`).\n2. A repository chosen per tenant, which would mean\n   a new field when approving.';
  assistant(agent, [{ type: 'text', text }], { stop_reason: 'end_turn' });
  assert.strictEqual(agent.waiting, true);
  assert.strictEqual(agent.waitingAsk, 'which app repository do SaaS tenants run?');
});

test('a question quoted mid-message, or a closing list with no question, does not wait', () => {
  const { agent } = newAgent();
  assistant(agent, [{ type: 'text', text: 'It answers the prospect who asks "why pay when Claude can do OSINT?" well.\n\nThe next step I recommend is change tracking.' }], { stop_reason: 'end_turn' });
  assert.strictEqual(agent.waiting, false);
  assistant(agent, [{ type: 'text', text: 'Here is what changed:\n\n- the parser\n- the tests' }], { stop_reason: 'end_turn' });
  assert.strictEqual(agent.waiting, false);
});

test('a desktop wrap-up ask waits on you', () => {
  const { agent } = newAgent();
  assistant(agent, [{ type: 'tool_use', id: 'wu', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Fixed.', ask: 'Commit this?' } }]);
  assistant(agent, [{ type: 'text', text: 'All fixed.' }], { stop_reason: 'end_turn' });
  assert.strictEqual(agent.waitingAsk, 'Commit this?');
});

test('an interrupt is counted', () => {
  const { agent } = newAgent();
  feed(agent, { type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  assert.strictEqual(agent.interrupts, 1);
});

test('a failing build hidden by a pipe is caught, and a passing one clears it', () => {
  const { agent } = newAgent();
  bash(agent, 'b1', './mvnw compile -q | tail -20');
  toolResult(agent, 'b1', '[ERROR] COMPILATION ERROR : cannot find symbol');
  let problems = problemsOf(agent.project, Date.now());
  assert.deepStrictEqual(problems.failing.map((f) => f.kind), ['build']);
  bash(agent, 'b2', './mvnw compile -q');
  toolResult(agent, 'b2', '');
  problems = problemsOf(agent.project, Date.now());
  assert.strictEqual(problems.failing.length, 0);
});

test('failing tests are caught from the exit code', () => {
  const { agent } = newAgent();
  bash(agent, 't1', 'npm test');
  toolResult(agent, 't1', 'Exit code 1\n3 failing', true);
  const problems = problemsOf(agent.project, Date.now());
  assert.deepStrictEqual(problems.failing.map((f) => f.kind), ['tests']);
  assert.strictEqual(problems.errorsLastHour, 1);
});

test('a blocked command is not a failure or an error', () => {
  const { agent } = newAgent();
  bash(agent, 'x1', 'npm test');
  toolResult(agent, 'x1', 'This command requires approval', true);
  const problems = problemsOf(agent.project, Date.now());
  assert.strictEqual(problems.failing.length, 0);
  assert.strictEqual(problems.errorsLastHour, 0);
});

test('the card reads the conversation and files changed', () => {
  const { agent, cwd } = newAgent();
  const file = path.join(cwd, 'session.jsonl');
  const lines = [
    { type: 'user', timestamp: at(), message: { role: 'user', content: 'Add a logout button' } },
    { type: 'assistant', timestamp: at(), message: { content: [{ type: 'text', text: 'Adding it now.' }, { type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: path.join(cwd, 'nav.js'), old_string: 'a', new_string: 'a\nb' } }] } },
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  agent.logFile = file;
  const conversation = conversationOf(agent.id);
  assert.strictEqual(conversation.task, 'Add a logout button');
  assert.deepStrictEqual(conversation.messages.map((m) => m.role), ['you', 'agent', 'tool']);
  assert.deepStrictEqual(conversation.files.map((f) => [path.basename(f.path), f.added, f.removed]), [['nav.js', 2, 1]]);
});

test('codex: project, model, cost, patches and failed commands', () => {
  const agent = getAgent('codex:test-1', 'codex');
  const cwd = projectFolder();
  const codex = (type, payload) => handleCodexLine(agent, JSON.stringify({ type, timestamp: at(), payload }));
  codex('session_meta', { cwd });
  codex('turn_context', { model: 'gpt-5-codex' });
  codex('response_item', { type: 'function_call', name: 'apply_patch', arguments: '*** Begin Patch\n*** Update File: app.py\n-old\n+new\n+more\n*** End Patch' });
  codex('response_item', { type: 'function_call_output', output: 'Exit code: 2' });
  codex('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 } } });
  assert.strictEqual(agent.project, path.basename(cwd));
  assert.strictEqual(agent.model, 'gpt-5-codex');
  assert.strictEqual(agent.linesAdded, 2);
  assert.strictEqual(agent.linesRemoved, 1);
  assert.strictEqual(agent.toolErrors, 1);
  assert.ok(agent.cost > 0);
});

function eventsOf(agent, kind) {
  return events.filter((e) => e.agentId === agent.id && e.kind === kind);
}

test('a finished turn leaves a summary: the desktop recap, else the first sentence of the closing message', () => {
  const { agent } = newAgent();
  assistant(agent, [{ type: 'tool_use', id: 'wu1', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Fixed the login bug; tests pass. Not committed.' } }]);
  assistant(agent, [{ type: 'text', text: 'All done.' }], { stop_reason: 'end_turn' });
  assert.strictEqual(agent.summary.text, 'Fixed the login bug; tests pass.');
  const other = newAgent().agent;
  assistant(other, [{ type: 'text', text: '## Result\n\n**Added** the `export` button to reports. It works on both pages.' }], { stop_reason: 'end_turn' });
  assert.strictEqual(other.summary.text, 'Added the export button to reports.');
});

test('updates are posted at most once per agent every 10 minutes, and never twice the same', () => {
  const { agent } = newAgent();
  assistant(agent, [{ type: 'text', text: 'Wrote the parser.' }], { stop_reason: 'end_turn' });
  assistant(agent, [{ type: 'text', text: 'Wrote the parser.' }], { stop_reason: 'end_turn' });
  assistant(agent, [{ type: 'text', text: 'Added tests for the parser.' }], { stop_reason: 'end_turn' });
  assert.deepStrictEqual(eventsOf(agent, 'update').map((e) => e.text), ['Added tests for the parser.']);
  clock += 11 * 60_000;
  assistant(agent, [{ type: 'text', text: 'Hooked the parser into the server.' }], { stop_reason: 'end_turn' });
  assert.strictEqual(eventsOf(agent, 'update').length, 2);
});

test('a turn that asks you something posts the question, not an update', () => {
  const { agent } = newAgent();
  assistant(agent, [{ type: 'text', text: 'Drafted both options. Which one should I build?' }], { stop_reason: 'end_turn' });
  assert.strictEqual(eventsOf(agent, 'update').length, 0);
  assert.deepStrictEqual(eventsOf(agent, 'waiting').map((e) => e.text), ['is waiting for your review: Which one should I build?']);
  assert.strictEqual(agent.summary.text, 'Drafted both options.');
});

test('a build breaking and recovering is posted once each, not on every failing run', () => {
  const { agent } = newAgent();
  for (const [id, output] of [['c1', '[ERROR] COMPILATION ERROR'], ['c2', '[ERROR] COMPILATION ERROR'], ['c3', 'ok']]) {
    bash(agent, id, './mvnw compile -q | tail');
    toolResult(agent, id, output);
  }
  assert.deepStrictEqual(eventsOf(agent, 'broke').map((e) => e.text), [`Build failing in ${agent.project}`]);
  assert.deepStrictEqual(eventsOf(agent, 'fixed').map((e) => e.text), [`Build passing again in ${agent.project}`]);
});
