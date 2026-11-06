// Reads Codex session lines into agent records.
const { addCost, addEvent, addLines, endTurn, markHuman, markInterrupted, pushRecent, shortTarget, touch } = require('../agents');
const { priceFor } = require('../pricing');
const { setProject } = require('../projects');

function patchStats(patch) {
  let added = 0;
  let removed = 0;
  let file = '';
  for (const row of String(patch).split('\n')) {
    if (row.startsWith('*** ') && row.includes('File: ')) file = row.split('File: ')[1];
    else if (row.startsWith('+') && !row.startsWith('+++')) added += 1;
    else if (row.startsWith('-') && !row.startsWith('---')) removed += 1;
  }
  return { added, removed, file };
}

function handleCodexLine(agent, line) {
  let record;
  try { record = JSON.parse(line); } catch { return; }
  const ts = record.timestamp ? Date.parse(record.timestamp) : 0;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return;
  touch(agent, ts);
  if (record.type === 'session_meta' && payload.cwd) setProject(agent, payload.cwd);
  if (record.type === 'turn_context' && payload.model) agent.model = payload.model;
  if (payload.type === 'thread_settings_applied' && payload.thread_settings?.model) agent.model = payload.thread_settings.model;
  const isUserMessage = payload.type === 'user_message' || (payload.type === 'item_completed' && payload.item?.type === 'UserMessage');
  if (isUserMessage) markHuman(agent, ts);
  if (payload.type === 'turn_aborted') markInterrupted(agent, ts);
  if (payload.type === 'task_complete') {
    agent.lastText = String(payload.last_agent_message || '');
    endTurn(agent, ts);
  }

  if (payload.type === 'token_count' && payload.info?.total_token_usage) {
    const total = payload.info.total_token_usage;
    const cached = total.cached_input_tokens || 0;
    const uncached = (total.input_tokens || 0) - cached;
    const price = priceFor(agent.model || 'gpt');
    const totalCost = (uncached * price.input + cached * price.cacheRead + (total.output_tokens || 0) * price.output) / 1e6;
    agent.tokens.input = uncached;
    agent.tokens.cacheRead = cached;
    agent.tokens.output = total.output_tokens || 0;
    agent.context = payload.info.last_token_usage?.input_tokens || agent.context;
    const delta = totalCost - agent.cost;
    if (delta > 0) addCost(agent, ts, delta);
  }

  const isCall = payload.type === 'function_call' || payload.type === 'custom_tool_call';
  if (isCall) {
    agent.toolCalls += 1;
    agent.waiting = false;
    const body = payload.input || payload.arguments || '';
    agent.lastAction = shortTarget(payload.name, { command: body });
    if (String(body).includes('*** Begin Patch')) {
      const stats = patchStats(body);
      addLines(agent, ts, stats.added, stats.removed, stats.file, 'Patched');
    }
  }

  const isOutput = payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output';
  if (isOutput) {
    const output = String(typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output));
    if (/Exit code: [1-9]|"exit_code":[1-9]/.test(output)) {
      agent.toolErrors += 1;
      pushRecent(agent, { ts, cost: 0, err: 1 });
      addEvent(agent, ts, 'error', 'a command failed');
    }
  }
}

module.exports = { handleCodexLine };
