// The agent card: whether it needs you, its task, activity and files, and (expanded) a conversation you can type into.
import { CLAN_ID } from '../config.js';
import { addToast, autonomy, statusLabel } from '../hud.js';
import { efficiency, levelOf, levelProgress, prettyModel, xpOf } from '../identity.js';
import { HIRED_MARK, drawPerson } from '../people.js';
import { sendAway } from '../simulation.js';
import { state } from '../state.js';
import { api, openTerminalIn } from '../ui/forms.js';
import { clockTime, compact, duration, escapeHtml, money } from '../utils.js';

const DETAILS_REFRESH_MS = 3000;
const COMPACT_ACTIVITY = 5;
const COMPACT_FILES = 6;
const WATCH_ONLY = 'Watch-only: this agent lives in the Claude app, so reply to it there.';
const RELEASE_CONFIRM_MS = 4000;
const RELEASE_LABEL = '👋 RELEASE';

const sheet = document.getElementById('sheet');
const thread = document.getElementById('chatThread');
const ordersInput = document.getElementById('ordersInput');
// The selected agent's transcript, fetched from the server while its card is open.
let details = null;
let threadKey = '';
let showMoreStats = false;
let releaseArmedUntil = 0;

function isExpanded() {
  return sheet.classList.contains('expanded');
}

export function renderSheet() {
  const worker = state.workers.get(state.selectedId);
  if (!worker) {
    closeSheet();
    return;
  }
  const agent = worker.agent;
  const hiredNote = agent.portal ? ` · ${HIRED_MARK} hired from the town` : agent.owner ? ` · ${agent.owner}'s agent` : '';
  document.getElementById('sheetName').textContent = worker.look.name;
  document.getElementById('sheetClass').textContent = `${prettyModel(agent.model)} ${worker.look.className}${hiredNote}`;
  document.getElementById('sheetLevel').textContent = `${agent.project} · ${statusLabel(agent.status, agent.owner)}`;
  renderStateLine(agent);
  renderTask(agent);
  renderStats(agent);
  renderMoreStats(agent);
  renderBlocked(agent);
  renderActivity(agent);
  renderFiles();
  renderThread();
  renderOrdersBox(agent);
  document.getElementById('btnFollow').classList.toggle('on', state.following);
  drawPortrait(worker);
}

// One line that answers "do I need to do anything?".
function stateLine(agent) {
  const now = Date.now();
  const portal = agent.portal;
  const doing = agent.lastAction || 'getting started';
  if (portal && portal.running) {
    const runningFor = portal.startedAt ? ` for ${duration(now - portal.startedAt)}` : '';
    return { kind: 'working', text: `⚒ Working${runningFor} · ${doing}` };
  }
  const outcome = portal && portal.outcome;
  if (outcome && outcome.state === 'needs-you') return { kind: 'needs', text: `🙋 Needs you · ${outcome.summary}` };
  if (outcome) return { kind: 'done', text: `✓ Done ${duration(now - outcome.ts)} ago · ready for the next task` };
  if (agent.status === 'waiting' && agent.owner) {
    const question = agent.waitingAsk ? ` · ${agent.waitingAsk}` : '';
    return { kind: 'needs', text: `🙋 Waiting on ${agent.owner} for ${duration(now - agent.waitingSince)}${question}` };
  }
  if (agent.status === 'waiting') {
    return { kind: 'needs', text: `🙋 Waiting on you for ${duration(now - agent.waitingSince)} · ${agent.waitingAsk}` };
  }
  if (agent.status === 'stuck' || agent.status === 'overworked') return { kind: 'trouble', text: `${statusLabel(agent.status)} · ${doing}` };
  if (agent.status === 'working') return { kind: 'working', text: `⚒ Working · ${doing}` };
  return { kind: '', text: `${statusLabel(agent.status)} · last active ${duration(now - agent.lastTs)} ago` };
}

function renderStateLine(agent) {
  const line = stateLine(agent);
  const element = document.getElementById('sheetState');
  element.className = `state-line ${line.kind}`;
  element.textContent = line.text;
  // What the agent said it did at the end of its last turn.
  const summary = document.getElementById('sheetNow');
  summary.style.display = agent.summary ? '' : 'none';
  summary.textContent = agent.summary ? `💬 ${agent.summary.text} · ${duration(Date.now() - agent.summary.ts)} ago` : '';
}

function renderTask(agent) {
  const task = (details && details.task) || agent.title || `Work on ${agent.project}`;
  const element = document.getElementById('sheetTask');
  if (element.textContent !== task) element.textContent = task;
}

function statsHtml(stats) {
  return stats.map(([label, value]) => `<div><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join('');
}

function renderStats(agent) {
  const portal = agent.portal;
  const running = portal && portal.running && portal.startedAt;
  const stats = [
    ['Cost', money(agent.cost)],
    running ? ['Running', duration(Date.now() - portal.startedAt)] : ['Shift', duration(agent.shiftHours * 3600000)],
    ['Files', agent.filesTouched],
    ['Lines', `+${compact(agent.linesAdded)} −${compact(agent.linesRemoved)}`],
    ['Errors 15m', agent.recentErrors],
    ['Context', compact(agent.context)],
  ];
  document.getElementById('sheetStats').innerHTML = statsHtml(stats);
}

function renderMoreStats(agent) {
  document.getElementById('sheetMore').classList.toggle('open', showMoreStats);
  document.getElementById('sheetMoreToggle').textContent = showMoreStats ? 'FEWER STATS ▾' : 'MORE STATS ▸';
  if (!showMoreStats) return;
  const xp = xpOf(agent);
  document.getElementById('sheetXp').style.width = `${levelProgress(xp) * 100}%`;
  const energy = Math.max(0, 100 - agent.stress);
  document.getElementById('sheetEnergyBar').className = `bar ${energy < 35 ? 'bad' : energy < 60 ? 'warn' : ''}`;
  document.getElementById('sheetEnergy').style.width = `${energy}%`;
  const accuracy = agent.toolCalls ? Math.round(100 * (1 - agent.toolErrors / agent.toolCalls)) : 100;
  const stats = [
    ['Level', levelOf(xp)],
    ['Burn', `${money(agent.burnPerHour)}/h`],
    ['Tool uses', compact(agent.toolCalls)],
    ['Accuracy', `${accuracy}%`],
    ['Tokens out', compact(agent.tokens.output)],
    ['Lines / $', compact(efficiency(agent))],
    ['Last seen', `${duration(Date.now() - agent.lastTs)} ago`],
    ['Your msgs', agent.humanMsgs],
    ['Stopped', agent.interrupts],
    ['Autonomy', autonomy(agent)],
    ['You last', agent.lastHumanTs ? `${duration(Date.now() - agent.lastHumanTs)} ago` : 'never'],
  ];
  document.getElementById('sheetMoreStats').innerHTML = statsHtml(stats);
}

function renderBlocked(agent) {
  const outcome = agent.portal && agent.portal.outcome;
  const blocked = outcome && outcome.state === 'needs-you' && Array.isArray(outcome.blocked) ? outcome.blocked : [];
  const actions = blocked.filter((action) => action && action.text);
  document.getElementById('blockedBox').classList.toggle('open', actions.length > 0);
  if (!actions.length) return;
  document.getElementById('blockedList').innerHTML = actions.map((action) => {
    const folders = action.folders && action.folders.length ? `<span class="dir"> · and access to ${escapeHtml(action.folders.join(', '))}</span>` : '';
    return `<li>${escapeHtml(action.text)}${folders}</li>`;
  }).join('');
}

function renderActivity(agent) {
  const list = document.getElementById('sheetActivity');
  if (!details || !details.readable) {
    list.innerHTML = agent.lastAction
      ? `<li><span class="t">${clockTime(agent.lastTs)}</span><span class="what">${escapeHtml(agent.lastAction)}</span></li>`
      : '<li class="empty">No actions yet.</li>';
    return;
  }
  const limit = isExpanded() ? details.activity.length : COMPACT_ACTIVITY;
  const items = details.activity.slice(-limit).reverse();
  list.innerHTML = items.map((item) => (
    `<li class="${item.error ? 'error' : ''}" title="${escapeHtml(item.text)}">`
    + `<span class="t">${clockTime(item.ts)}</span><span class="what">${item.error ? '✗ ' : ''}${escapeHtml(item.text)}</span></li>`
  )).join('') || '<li class="empty">No actions yet.</li>';
}

function renderFiles() {
  const files = details && details.readable ? details.files : [];
  document.getElementById('filesBox').classList.toggle('open', files.length > 0);
  if (!files.length) return;
  const shown = isExpanded() ? files : files.slice(0, COMPACT_FILES);
  const hidden = files.length - shown.length;
  document.getElementById('filesLabel').textContent = `FILES CHANGED (${files.length})`;
  document.getElementById('sheetFiles').innerHTML = shown.map((file) => {
    const parts = file.path.split('/');
    const name = parts.pop();
    const folder = parts.slice(-2).join('/');
    return `<li title="${escapeHtml(file.path)}"><span class="name">${escapeHtml(name)} <span class="dir">${escapeHtml(folder)}</span></span>`
      + `<span class="add">+${compact(file.added)}</span><span class="del">−${compact(file.removed)}</span></li>`;
  }).join('') + (hidden > 0 ? `<li class="empty">…and ${hidden} more (expand to see all)</li>` : '');
}

// Just enough markdown for agent replies: headings, bold and inline code, applied after escaping.
function simpleMarkdown(text) {
  return escapeHtml(text)
    .replace(/^#{1,6} (.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function renderThread() {
  if (!details) {
    if (threadKey !== 'loading') thread.innerHTML = '<div class="empty">Loading the conversation…</div>';
    threadKey = 'loading';
    return;
  }
  const messages = details.messages;
  const last = messages[messages.length - 1];
  const key = `${messages.length}:${last ? last.ts : 0}:${details.readable}`;
  if (key === threadKey) return;
  threadKey = key;
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
  if (!details.readable) {
    thread.innerHTML = "<div class=\"empty\">This agent's conversation can't be shown here.</div>";
    return;
  }
  thread.innerHTML = messages.map((message) => {
    if (message.role === 'tool') return `<div class="msg tool" title="${escapeHtml(message.text)}">⚙ ${escapeHtml(message.text)}</div>`;
    if (message.role === 'note') return `<div class="msg note">${escapeHtml(message.text)}</div>`;
    const who = message.role === 'you' ? 'You' : 'Agent';
    const body = message.role === 'agent' ? simpleMarkdown(message.text) : escapeHtml(message.text);
    return `<div class="msg ${message.role}"><span class="t">${who} · ${clockTime(message.ts)}</span>${body}</div>`;
  }).join('') || '<div class="empty">No messages yet.</div>';
  if (nearBottom) thread.scrollTop = thread.scrollHeight;
}

function renderOrdersBox(agent) {
  const portal = agent.portal;
  const running = Boolean(portal && portal.running);
  const outcome = portal && portal.outcome;
  document.getElementById('ordersBox').classList.toggle('open', Boolean(portal));
  document.getElementById('btnOrders').style.display = portal ? '' : 'none';
  document.getElementById('btnTerminal').style.display = portal ? '' : 'none';
  document.getElementById('btnStop').style.display = running ? '' : 'none';
  document.getElementById('btnRelease').style.display = portal ? '' : 'none';
  document.getElementById('watchOnlyNote').textContent = portal ? '' : agent.owner ? `Watch-only: only ${agent.owner} can talk to this agent.` : WATCH_ONLY;
  document.getElementById('replyBox').classList.toggle('open', Boolean(outcome && outcome.reply));
  if (!portal) return;
  if (outcome) document.getElementById('sheetReply').textContent = outcome.reply;
  document.getElementById('btnOrders').disabled = running;
  document.getElementById('btnTerminal').disabled = running;
  document.getElementById('btnRetry').disabled = running;
  for (const chip of document.querySelectorAll('#quickReplies .chip')) chip.disabled = running;
  document.getElementById('ordersNote').textContent = running
    ? 'Working on your last message. You can send more once it finishes, or stop it.'
    : '';
}

async function refreshDetails() {
  const agentId = state.selectedId;
  // A clan's town never gets transcripts: only the agent's status and current tool are shared.
  if (CLAN_ID || !agentId || document.visibilityState !== 'visible') return;
  const result = await api(`/api/agents/${encodeURIComponent(agentId)}/conversation`, {}, true);
  if (agentId !== state.selectedId || !result.ok) return;
  details = result;
  renderSheet();
}

setInterval(refreshDetails, DETAILS_REFRESH_MS);

async function sendMessage(message) {
  if (!message || !state.selectedId) return;
  const result = await api(`/api/agents/${encodeURIComponent(state.selectedId)}/orders`, { message });
  if (!result.ok) return;
  ordersInput.value = '';
  addToast('📋 Sent', 'info');
  refreshDetails();
}

document.getElementById('btnOrders').onclick = () => sendMessage(ordersInput.value.trim());

ordersInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  if (!document.getElementById('btnOrders').disabled) sendMessage(ordersInput.value.trim());
});

document.getElementById('quickReplies').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip && !chip.disabled) sendMessage(chip.dataset.reply);
});

document.getElementById('btnRetry').onclick = async () => {
  if (!state.selectedId) return;
  const result = await api(`/api/agents/${encodeURIComponent(state.selectedId)}/retry`);
  if (!result.ok) return;
  addToast('✓ Retrying with your approval', 'info');
  refreshDetails();
};

document.getElementById('btnTerminal').onclick = async () => {
  if (!state.selectedId) return;
  const result = await api(`/api/agents/${encodeURIComponent(state.selectedId)}/terminal`);
  if (result.ok) addToast('💻 Opened in Terminal. Keep talking to it there.', 'info');
};

document.getElementById('btnStop').onclick = async () => {
  if (!state.selectedId) return;
  const result = await api(`/api/agents/${encodeURIComponent(state.selectedId)}/stop`);
  if (result.ok) addToast('✋ Agent stopped', 'info');
};

// Release asks for a second click instead of a dialog: the wallpaper's web view doesn't show confirm() boxes.
document.getElementById('btnRelease').onclick = async (e) => {
  const button = e.currentTarget;
  const agentId = state.selectedId;
  if (!agentId) return;
  if (Date.now() > releaseArmedUntil) {
    const worker = state.workers.get(agentId);
    const running = worker && worker.agent.portal && worker.agent.portal.running;
    releaseArmedUntil = Date.now() + RELEASE_CONFIRM_MS;
    button.textContent = running ? 'STOP IT AND RELEASE?' : 'CLICK AGAIN TO RELEASE';
    button.classList.add('danger');
    setTimeout(() => {
      button.textContent = RELEASE_LABEL;
      button.classList.remove('danger');
    }, RELEASE_CONFIRM_MS);
    return;
  }
  releaseArmedUntil = 0;
  button.textContent = RELEASE_LABEL;
  button.classList.remove('danger');
  const result = await api(`/api/agents/${encodeURIComponent(agentId)}/release`);
  if (!result.ok) return;
  const name = state.workers.get(agentId)?.look.name || 'The agent';
  sendAway(agentId);
  closeSheet();
  addToast(`👋 ${name} was released. Its conversation stays in Claude's history.`, 'info');
};

document.getElementById('sheetTask').onclick = (e) => e.currentTarget.classList.toggle('full');

document.getElementById('sheetMoreToggle').onclick = () => {
  showMoreStats = !showMoreStats;
  renderSheet();
};

document.getElementById('sheetExpand').onclick = () => {
  const expanded = sheet.classList.toggle('expanded');
  const button = document.getElementById('sheetExpand');
  button.textContent = expanded ? '⤡' : '⤢';
  button.title = expanded ? 'Shrink back to the card' : 'Expand to talk to this agent';
  renderSheet();
  if (!expanded) return;
  thread.scrollTop = thread.scrollHeight;
  ordersInput.focus();
};

function drawPortrait(worker) {
  const portrait = document.getElementById('portrait');
  const p = portrait.getContext('2d');
  p.imageSmoothingEnabled = false;
  p.fillStyle = '#1f3a2a';
  p.fillRect(0, 0, 24, 24);
  drawPerson(p, 12, 20, worker, { pose: 'stand', portrait: true });
}

export function selectWorker(id, focus) {
  if (id !== state.selectedId) {
    details = null;
    threadKey = '';
    document.getElementById('sheetTask').classList.remove('full');
  }
  state.selectedId = id;
  sheet.classList.add('open');
  if (focus) {
    const worker = state.workers.get(id);
    state.camera.x = worker.x;
    state.camera.y = worker.y;
    state.camera.zoom = Math.max(state.camera.zoom, 3);
  }
  renderSheet();
  refreshDetails();
}

export function closeSheet() {
  state.selectedId = null;
  state.following = false;
  sheet.classList.remove('open');
}

document.getElementById('sheetClose').onclick = closeSheet;
document.getElementById('btnShell').onclick = () => {
  const worker = state.workers.get(state.selectedId);
  if (worker) openTerminalIn(worker.agent.project);
};
document.getElementById('btnFollow').onclick = () => {
  state.following = !state.following;
  renderSheet();
};
