// What's wrong in each project: the last build and test run (a broken build stays visible until one passes),
// and how many tool errors agents hit there in the last hour.
const { creditedProject } = require('./agents');
const { MIN } = require('./config');

const TEST_COMMAND = /\b(mvnw?|gradlew?)\b[^|;&]*\b(test|verify)\b|\b(npm|yarn|pnpm)( run)? test\b|\bpytest\b|\bgo test\b|\bcargo test\b|\bnpx (jest|vitest|playwright)\b|\bng test\b/;
const BUILD_COMMAND = /\b(mvnw?|gradlew?)\b[^|;&]*\b(compile|package|install|build|assemble)\b|\b(npm|yarn|pnpm)( run)? build\b|\bng build\b|\btsc\b|\bgo build\b|\bcargo (build|check)\b/;
// Piping into tail or grep hides a failing exit code, so the output is checked too.
const FAILURE_OUTPUT = /BUILD FAIL(URE|ED)|COMPILATION ERROR|^\[ERROR\]|Tests run:[^\n]*(Failures|Errors): [1-9]|npm ERR!|error TS\d+|\b[1-9]\d* (failing|failed)\b|^FAIL\b|panicked at|error\[E\d+\]/m;
// A blocked or interrupted command never ran, so it says nothing about the project.
const NOT_RUN = /requires approval|was blocked|permission to use|haven't granted|Request interrupted/i;
const COMMAND_FOLDER = /(?:\bcd\s+|\s-[fC]\s+|--prefix\s+)["']?(\/[^"'\s;&|]+)/;
const ERROR_WINDOW_MS = 60 * MIN;
const WORK_HERE_MS = 15 * MIN;

const projectChecks = new Map();
const projectErrors = new Map();

function checkKind(command) {
  if (TEST_COMMAND.test(command)) return 'tests';
  if (BUILD_COMMAND.test(command)) return 'build';
  return '';
}

function workingProject(agent, ts) {
  const recent = agent.workProject && ts - agent.workProjectTs < WORK_HERE_MS;
  return recent ? agent.workProject : agent.project;
}

// A build run in another folder (`cd /x && mvn …`, `mvn -f /x/pom.xml`) counts for that folder's project.
function checkProject(agent, command, ts) {
  const folder = command.match(COMMAND_FOLDER);
  const elsewhere = folder ? creditedProject(agent, `${folder[1].replace(/\/pom\.xml$/, '')}/pom.xml`) : '';
  return elsewhere || workingProject(agent, ts);
}

function noteCommand(agent, toolUseId, command, ts) {
  const kind = checkKind(command || '');
  if (!kind || !toolUseId) return;
  agent.pendingChecks.set(toolUseId, { kind, command: command.replace(/\s+/g, ' ').slice(0, 120), ts, project: checkProject(agent, command, ts) });
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function noteError(project, ts) {
  const cutoff = Date.now() - ERROR_WINDOW_MS;
  if (ts < cutoff) return;
  const recent = (projectErrors.get(project) || []).filter((t) => t >= cutoff);
  recent.push(ts);
  projectErrors.set(project, recent);
}

function noteResult(agent, block, ts) {
  const text = resultText(block.content);
  if (block.is_error && !NOT_RUN.test(text)) noteError(workingProject(agent, ts), ts);
  const pending = agent.pendingChecks.get(block.tool_use_id);
  if (!pending) return;
  agent.pendingChecks.delete(block.tool_use_id);
  if (NOT_RUN.test(text)) return;
  const ok = !block.is_error && !FAILURE_OUTPUT.test(text);
  const checks = projectChecks.get(pending.project) || {};
  checks[pending.kind] = { ok, command: pending.command, ts, agentId: agent.id };
  projectChecks.set(pending.project, checks);
}

// A failure older than a day is history, not a live problem.
const STALE_FAILURE_MS = 24 * 60 * MIN;

function problemsOf(project, now) {
  const checks = projectChecks.get(project) || {};
  const failing = ['build', 'tests']
    .filter((kind) => checks[kind] && !checks[kind].ok && now - checks[kind].ts < STALE_FAILURE_MS)
    .map((kind) => ({ kind, ...checks[kind] }));
  const errorsLastHour = (projectErrors.get(project) || []).filter((ts) => now - ts < ERROR_WINDOW_MS).length;
  return { failing, errorsLastHour };
}

module.exports = { noteCommand, noteResult, problemsOf };
