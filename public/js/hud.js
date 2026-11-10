// The status bar, chronicle, toasts and clock.
import { CLAN_ID } from './config.js';
import { lighting } from './lighting.js';
import { currentReviewee, reviewQueue } from './simulation.js';
import { state } from './state.js';
import { renderBoard, renderCrew } from './ui/boards.js';
import { renderFeed } from './ui/feed.js';
import { selectWorker } from './ui/sheet.js';
import { clockTime, compact, escapeHtml, icon, money, saveBudget } from './utils.js';

const chronicle = [];

export function ingestEvents(events, first) {
  for (const event of events) {
    const key = `${event.ts}|${event.agentId}|${event.text}`;
    if (state.seenEventKeys.has(key)) continue;
    state.seenEventKeys.add(key);
    chronicle.push(event);
  }
  if (first) chronicle.sort((a, b) => a.ts - b.ts);
  if (chronicle.length > 60) chronicle.splice(0, chronicle.length - 60);
  renderChronicle();
}

export function addChronicle(event) {
  chronicle.push(event);
  renderChronicle();
}

function renderChronicle() {
  const list = document.getElementById('chronicleList');
  const items = chronicle.slice(-7).reverse();
  list.innerHTML = items.map((event) => {
    const worker = state.workers.get(event.agentId);
    const owner = worker && worker.agent.owner ? ` (${worker.agent.owner})` : '';
    const who = worker ? `${worker.look.name}${owner}@${worker.agent.project}` : event.project || 'someone';
    return `<li data-id="${escapeHtml(event.agentId)}" class="${event.kind}"><span class="t">${clockTime(event.ts)}</span>${escapeHtml(who)} ${escapeHtml(event.text)}</li>`;
  }).join('') || '<li style="color:var(--muted)">All quiet in the colony…</li>';
}

document.getElementById('chronicleList').addEventListener('click', (e) => {
  const item = e.target.closest('li[data-id]');
  if (item && state.workers.has(item.dataset.id)) selectWorker(item.dataset.id, true);
});

export function addToast(text, variant = '', iconName = '') {
  const box = document.getElementById('toasts');
  const toast = document.createElement('div');
  toast.className = `toast ${variant}`;
  toast.innerHTML = `${iconName ? `${icon(iconName)} ` : ''}${escapeHtml(text)}`;
  box.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
  while (box.children.length > 3) box.firstChild.remove();
}

const budgetInput = document.getElementById('budgetInput');
budgetInput.value = state.budget;
budgetInput.addEventListener('change', () => {
  const value = Number(budgetInput.value);
  if (value > 0) {
    state.budget = value;
    saveBudget(value);
    renderHud();
  }
});

let lastCostToday = null;

function renderClanSeg(clan) {
  const online = clan.members.filter((member) => member.online).length;
  document.getElementById('clanSeg').innerHTML = `${icon('shield')} <b>${escapeHtml(clan.name)}</b><span class="dim">${online}/${clan.members.length} online</span>`;
  document.getElementById('popWaitWrap').title = clan.waitingOn.length
    ? `Waiting on ${clan.waitingOn.map((w) => `${w.login} (${w.count})`).join(', ')} — click to visit the first`
    : 'Nobody is being waited on';
  document.title = `${clan.name} · Agent Colony`;
}

export function renderHud() {
  const data = state.data;
  if (!data) return;
  if (data.clan) renderClanSeg(data.clan);
  const costToday = data.totals.costToday;
  const amount = document.getElementById('treasuryAmount');
  amount.textContent = money(costToday);
  if (lastCostToday !== null && costToday > lastCostToday) {
    amount.classList.add('flash');
    setTimeout(() => amount.classList.remove('flash'), 400);
  }
  lastCostToday = costToday;
  const ratio = costToday / state.budget;
  const bar = document.getElementById('budgetBar');
  bar.firstElementChild.style.width = `${Math.min(100, ratio * 100)}%`;
  bar.className = `bar ${ratio >= 1 ? 'bad' : ratio >= 0.75 ? 'warn' : ''}`;
  document.getElementById('monthCost').textContent = money(data.totals.costAllTime);
  document.getElementById('budgetLabel').textContent = money(state.budget);
  document.getElementById('linesToday').textContent = compact(data.totals.linesToday);

  const counts = { working: 0, idle: 0, sleeping: 0, overworked: 0, stuck: 0, waiting: 0 };
  let burn = 0;
  for (const agent of data.agents) {
    counts[agent.status] += 1;
    burn += agent.burnPerHour;
  }
  document.getElementById('popWorking').textContent = counts.working + counts.overworked + counts.stuck;
  document.getElementById('popIdle').textContent = counts.idle;
  document.getElementById('popSleeping').textContent = counts.sleeping;
  document.getElementById('popHot').textContent = counts.overworked;
  document.getElementById('popStuck').textContent = counts.stuck;
  document.getElementById('popBurn').textContent = `${money(burn)}/h`;
  document.getElementById('popHotWrap').classList.toggle('alert', counts.overworked > 0);
  document.getElementById('popStuckWrap').classList.toggle('alert', counts.stuck > 0);
  document.getElementById('popWait').textContent = counts.waiting;
  document.getElementById('popWaitWrap').classList.toggle('alert', counts.waiting > 0);
  const reviewee = currentReviewee();
  document.getElementById('popReview').textContent = reviewee ? `${reviewee.look.name}@${reviewee.agent.project}` : '—';
  renderFeed();
  if (document.getElementById('board').classList.contains('open')) renderBoard(state.boardMode);
  if (document.getElementById('crew').classList.contains('open')) renderCrew();
}

export const STATUS = {
  working: { icon: 'tools', text: 'Working' },
  idle: { icon: 'coffee', text: 'On break' },
  sleeping: { icon: 'bed', text: 'Asleep' },
  overworked: { icon: 'fire', text: 'Overworked' },
  stuck: { icon: 'square-alert', text: 'Stuck' },
  waiting: { icon: 'circle-question', text: 'Waiting on you' },
};

// HTML: the status's icon and words.
export function statusLabel(status, owner) {
  const { icon: iconName, text } = STATUS[status];
  const words = status === 'waiting' && owner ? `Waiting on ${owner}` : text;
  return `${icon(iconName)} ${escapeHtml(words)}`;
}

export function autonomy(agent) {
  if (!agent.humanMsgs) return agent.toolCalls ? `${compact(agent.toolCalls)}/msg` : '—';
  return `${(agent.toolCalls / agent.humanMsgs).toFixed(1)}/msg`;
}

document.getElementById('statusBar').addEventListener('click', () => {
  if (CLAN_ID) return;
  document.getElementById('statusDetails').classList.toggle('open');
});

document.getElementById('chronicleToggle').addEventListener('click', () => {
  const chronicle = document.getElementById('chronicle');
  chronicle.classList.toggle('expanded');
  document.getElementById('chronicleToggle').textContent = chronicle.classList.contains('expanded') ? '▾' : '▴';
});

document.getElementById('popWaitWrap').addEventListener('click', (event) => {
  event.stopPropagation();
  const first = reviewQueue()[0];
  if (first) selectWorker(first.id, true);
});

export function updateClock() {
  const now = new Date();
  const light = state.light || lighting();
  const preview = state.timeOverride !== null && state.timeOverride !== undefined ? ' (preview)' : '';
  const text = `${light.phase}${preview} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const clock = document.getElementById('cloud-sun');
  if (clock.dataset.text === text) return;
  clock.dataset.text = text;
  clock.innerHTML = `${icon(light.icon)} ${escapeHtml(text)}`;
}
