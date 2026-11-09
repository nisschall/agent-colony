// Reads Claude Code transcript lines into agent records.
const { addCost, addEvent, addLines, countLines, endTurn, humanText, markHuman, markInterrupted, pushRecent, shortTarget, startWaiting, touch } = require('../agents');
const { priceFor } = require('../pricing');
const { noteCommand, noteResult } = require('../checks');
const { setProject } = require('../projects');

function handleClaudeTool(agent, ts, block) {
  agent.toolCalls += 1;
  const input = block.input || {};
  agent.lastAction = shortTarget(block.name, input);
  agent.waiting = false;
  if (block.name.endsWith('wrap_up') && input.ask) {
    agent.pendingAsk = input.ask;
  } else if (block.name === 'AskUserQuestion') {
    startWaiting(agent, ts, input.questions?.[0]?.question || 'a question for you');
  } else if (block.name === 'ExitPlanMode') {
    startWaiting(agent, ts, 'plan approval');
  } else if (block.name === 'Edit') {
    addLines(agent, ts, countLines(input.new_string), countLines(input.old_string), input.file_path, 'Rebuilt');
  } else if (block.name === 'MultiEdit') {
    const editsList = input.edits || [];
    const added = editsList.reduce((sum, e) => sum + countLines(e.new_string), 0);
    const removed = editsList.reduce((sum, e) => sum + countLines(e.old_string), 0);
    addLines(agent, ts, added, removed, input.file_path, 'Rebuilt');
  } else if (block.name === 'Write') {
    addLines(agent, ts, countLines(input.content), 0, input.file_path, 'Built');
  } else if (block.name === 'Bash') {
    noteCommand(agent, block.id, input.command, ts);
  } else if (block.name === 'Agent' || block.name === 'Task') {
    addEvent(agent, ts, 'hire', `hired a helper: ${String(input.description || 'subagent').slice(0, 50)}`);
  }
}

function handleClaudeLine(agent, line) {
  const isUsage = line.includes('"usage"');
  const isTool = line.includes('"tool_use"') || line.includes('"tool_result"');
  const isMeta = line.includes('"custom-title"') || line.includes('"agent-name"') || line.includes('"relocated"')
    || (!agent.project || agent.project === 'unknown');
  const isHuman = line.includes('"kind":"human"') || line.includes('Request interrupted by user') || line.includes('"absorbed_mid_turn"');
  if (!isUsage && !isTool && !isMeta && !isHuman) return;
  let record;
  try { record = JSON.parse(line); } catch { return; }
  const ts = record.timestamp ? Date.parse(record.timestamp) : 0;
  // A session belongs to the folder it started in; the shell's cd into other folders doesn't move it.
  // Only a real move (the desktop app relocating the chat) does.
  if (record.cwd && !agent.cwd) setProject(agent, record.cwd);
  if (record.type === 'relocated' && record.relocatedCwd) setProject(agent, record.relocatedCwd);
  if (record.type === 'custom-title' && record.customTitle) agent.title = record.customTitle;
  if (record.type === 'agent-name' && record.agentName && !agent.title) agent.title = record.agentName;
  // A message you type while the agent is mid-turn is logged only as an absorbed queue entry.
  if (record.type === 'queue-operation' && record.reason === 'absorbed_mid_turn') {
    touch(agent, ts);
    markHuman(agent, ts);
    return;
  }
  const message = record.message;
  if (!message || typeof message !== 'object') return;
  touch(agent, ts);

  if (record.type === 'user' && !record.isMeta) {
    const text = humanText(message.content);
    if (text.includes('[Request interrupted by user')) markInterrupted(agent, ts);
    else if (record.origin?.kind === 'human' && !text.trimStart().startsWith('<')) markHuman(agent, ts);
  }

  if (record.type === 'assistant' && Array.isArray(message.content)) {
    const text = humanText(message.content);
    if (text) agent.lastText = text;
  }

  if (record.type === 'assistant' && message.usage && message.model !== '<synthetic>') {
    agent.model = message.model || agent.model;
    const msgId = message.id || record.uuid;
    if (!agent.seenMsgIds.has(msgId)) {
      agent.seenMsgIds.add(msgId);
      const usage = message.usage;
      const write1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
      const write5m = (usage.cache_creation_input_tokens || 0) - write1h;
      const price = priceFor(agent.model);
      const cost = ((usage.input_tokens || 0) * price.input
        + (usage.output_tokens || 0) * price.output
        + (usage.cache_read_input_tokens || 0) * price.cacheRead
        + write5m * price.input * 1.25
        + write1h * price.input * 2) / 1e6;
      agent.tokens.input += usage.input_tokens || 0;
      agent.tokens.output += usage.output_tokens || 0;
      agent.tokens.cacheRead += usage.cache_read_input_tokens || 0;
      agent.tokens.cacheWrite += usage.cache_creation_input_tokens || 0;
      agent.context = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      addCost(agent, ts, cost);
    }
  }

  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block.type === 'tool_use') handleClaudeTool(agent, ts, block);
    if (block.type === 'tool_result') noteResult(agent, block, ts);
    if (block.type === 'tool_result' && block.is_error) {
      agent.toolErrors += 1;
      pushRecent(agent, { ts, cost: 0, err: 1 });
      const reason = (typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')).slice(0, 70);
      addEvent(agent, ts, 'error', `tripped: ${reason}`);
    }
  }
  if (record.type === 'assistant' && message.stop_reason === 'end_turn') endTurn(agent, ts);
}

module.exports = { handleClaudeLine };
