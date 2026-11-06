// One agent's transcript as its card shows it: the task, the conversation, recent actions and files changed.
// Only new lines are read on each request, so keeping a card open on a busy agent stays cheap.
const fs = require('fs');
const { agents, countLines, humanText, shortTarget } = require('./agents');
const { ApiError } = require('./api-error');

const MESSAGE_LIMIT = 200;
const ACTIVITY_LIMIT = 8;
const FILE_LIMIT = 40;
const TEXT_LIMIT = 6000;
const CHUNK_BYTES = 8 * 1024 * 1024;
const readers = new Map();

function newReader() {
  return { offset: 0, partial: '', task: '', messages: [], activity: [], files: new Map() };
}

function pushLimited(list, item, limit) {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function editedLines(name, input) {
  if (name === 'Write') return { added: countLines(input.content), removed: 0 };
  if (name === 'Edit') return { added: countLines(input.new_string), removed: countLines(input.old_string) };
  const edits = input.edits || [];
  const added = edits.reduce((sum, e) => sum + countLines(e.new_string), 0);
  const removed = edits.reduce((sum, e) => sum + countLines(e.old_string), 0);
  return { added, removed };
}

function recordTool(reader, ts, block) {
  const input = block.input || {};
  const text = shortTarget(block.name, input);
  pushLimited(reader.activity, { ts, text, error: false }, ACTIVITY_LIMIT);
  pushLimited(reader.messages, { ts, role: 'tool', text }, MESSAGE_LIMIT);
  if (!['Edit', 'Write', 'MultiEdit'].includes(block.name) || !input.file_path) return;
  const lines = editedLines(block.name, input);
  const file = reader.files.get(input.file_path) || { path: input.file_path, added: 0, removed: 0, ts: 0 };
  file.added += lines.added;
  file.removed += lines.removed;
  file.ts = ts;
  reader.files.set(input.file_path, file);
}

function readLine(reader, line) {
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return;
  let record;
  try { record = JSON.parse(line); } catch { return; }
  const message = record.message;
  if (!message || typeof message !== 'object' || record.isMeta) return;
  const ts = record.timestamp ? Date.parse(record.timestamp) : 0;
  const text = humanText(message.content).trim();
  if (record.type === 'user') {
    if (text.includes('[Request interrupted by user')) {
      pushLimited(reader.messages, { ts, role: 'note', text: 'You stopped it.' }, MESSAGE_LIMIT);
    } else if (text && !text.startsWith('<')) {
      if (!reader.task) reader.task = text.slice(0, TEXT_LIMIT);
      pushLimited(reader.messages, { ts, role: 'you', text: text.slice(0, TEXT_LIMIT) }, MESSAGE_LIMIT);
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_result' && block.is_error && reader.activity.length) {
        reader.activity[reader.activity.length - 1].error = true;
      }
    }
    return;
  }
  if (text) pushLimited(reader.messages, { ts, role: 'agent', text: text.slice(0, TEXT_LIMIT) }, MESSAGE_LIMIT);
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === 'tool_use') recordTool(reader, ts, block);
  }
}

function catchUp(reader, file) {
  const size = fs.statSync(file).size;
  if (size < reader.offset) Object.assign(reader, newReader());
  if (size === reader.offset) return;
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - reader.offset));
  try {
    while (reader.offset < size) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - reader.offset), reader.offset);
      if (bytesRead <= 0) break;
      reader.offset += bytesRead;
      const lines = (reader.partial + buffer.toString('utf8', 0, bytesRead)).split('\n');
      reader.partial = lines.pop();
      for (const line of lines) readLine(reader, line);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function conversationOf(agentId) {
  const agent = agents.get(agentId);
  if (!agent) throw new ApiError(404, 'Unknown agent.');
  if (agent.kind === 'codex' || !agent.logFile) {
    return { readable: false, task: agent.title, messages: [], activity: [], files: [] };
  }
  let reader = readers.get(agent.logFile);
  if (!reader) {
    reader = newReader();
    readers.set(agent.logFile, reader);
  }
  try {
    catchUp(reader, agent.logFile);
  } catch {
    throw new ApiError(410, "This agent's log can't be read any more.");
  }
  const files = [...reader.files.values()].sort((a, b) => b.ts - a.ts).slice(0, FILE_LIMIT);
  return { readable: true, task: reader.task || agent.title, messages: reader.messages, activity: reader.activity, files };
}

module.exports = { conversationOf };
