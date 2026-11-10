// The hub's home page: sign in, your clans (open, invite, manage), create or join one, and your linked Macs.
const LEAVE_CONFIRM_MS = 4000;
const WAITING_REFRESH_MS = 15_000;
const ERRORS = {
  notmember: 'You are not in that clan, or it no longer exists.',
  blocked: 'This GitHub account is blocked on this hub.',
  waiting: 'Your account is waiting for a hub admin to approve it.',
};
const HOW_LET_IN = { admin: 'by an admin', org: 'by org membership', import: 'before approvals existed' };

const params = new URLSearchParams(location.search);
let me = null;
let armedLeave = { clanId: '', until: 0 };
let armedBlock = { userId: '', until: 0 };
let waitingTimer = null;

// A pixel icon from the town's /icons.svg (this page can't import the town's utils, which read town-only meta tags).
function icon(name) {
  return `<svg class="i" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ago(ts) {
  if (!ts) return 'never';
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function toast(text, variant = 'info', iconName = '') {
  const box = document.getElementById('toasts');
  const item = document.createElement('div');
  item.className = `toast ${variant}`;
  item.innerHTML = `${iconName ? `${icon(iconName)} ` : ''}${escapeHtml(text)}`;
  box.appendChild(item);
  setTimeout(() => item.remove(), 4500);
}

async function call(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({ ok: false, message: 'The hub did not answer.' }));
  if (!response.ok) {
    toast(result.message || 'Something went wrong.', '', 'warning-diamond');
    return null;
  }
  return result;
}

function memberChip(clan, member, isLeader) {
  const crown = member.role === 'leader' ? `${icon('crown')} ` : '';
  const remove = isLeader && member.login !== me.user.login
    ? `<button data-remove="${escapeHtml(member.login)}" data-clan="${escapeHtml(clan.id)}" title="Remove ${escapeHtml(member.login)} from the clan" aria-label="Remove ${escapeHtml(member.login)}">${icon('close')}</button>`
    : '';
  return `<span class="member ${member.role}">${crown}${escapeHtml(member.login)}${remove}</span>`;
}

function clanCard(clan) {
  const mine = clan.members.find((m) => m.login === me.user.login);
  const isLeader = mine && mine.role === 'leader';
  const armed = armedLeave.clanId === clan.id && Date.now() < armedLeave.until;
  const newCode = isLeader ? `<button class="btn" data-reset="${escapeHtml(clan.id)}">NEW CODE</button>` : '';
  return `<div class="clan">
    <div class="clan-head">
      <span class="clan-name">${escapeHtml(clan.name)} <span class="dim">· ${isLeader ? 'you lead it' : 'member'} · ${clan.members.length} member${clan.members.length === 1 ? '' : 's'}</span></span>
      <a class="btn primary" href="/clans/${encodeURIComponent(clan.id)}">OPEN TOWN</a>
    </div>
    <div class="members">${clan.members.map((m) => memberChip(clan, m, isLeader)).join('')}</div>
    <div class="invite"><span class="dim">Invite code</span><code>${escapeHtml(clan.inviteCode)}</code>
      <button class="btn" data-copy="${escapeHtml(clan.inviteCode)}">COPY INVITE LINK</button>${newCode}</div>
    <div class="actions"><button class="btn danger" data-leave="${escapeHtml(clan.id)}">${armed ? 'SURE? LEAVE' : 'LEAVE'}</button></div>
  </div>`;
}

async function renderClans() {
  const box = document.getElementById('clanList');
  if (!me.clans.length) {
    box.innerHTML = '<p class="dim">You are not in a clan yet. Create one below, or join with an invite code.</p>';
    return;
  }
  const details = await Promise.all(me.clans.map((clan) => call('GET', `/api/clans/${encodeURIComponent(clan.id)}`)));
  box.innerHTML = details.filter(Boolean).map((result) => clanCard(result.clan)).join('');
}

async function renderDevices() {
  const result = await call('GET', '/api/devices');
  const devices = result ? result.devices : [];
  document.getElementById('devices').innerHTML = devices.length
    ? `<table><tr><th>MAC</th><th>LINKED</th><th>LAST SENT</th><th class="end"></th></tr>${devices.map((d) => `<tr><td>${escapeHtml(d.label)}</td>`
      + `<td>${ago(d.createdAt)}</td><td>${ago(d.lastSeen)}</td><td class="end"><button class="btn danger" data-unlink="${escapeHtml(d.id)}">UNLINK</button></td></tr>`).join('')}</table>`
    : '<p class="dim">No Macs linked yet.</p>';
}

function personRow(person) {
  const name = person.name && person.name !== person.login ? ` <span class="dim">${escapeHtml(person.name)}</span>` : '';
  const crown = person.admin ? `${icon('crown')} ` : '';
  const letIn = person.admin ? 'hub admin' : HOW_LET_IN[person.approvedBy] || '';
  const how = person.status === 'approved' || person.admin
    ? `<span class="dim">${letIn}</span>`
    : `<span class="status-${person.status}">${person.status === 'pending' ? 'Waiting' : 'Blocked'}</span>`;
  const armed = armedBlock.userId === person.id && Date.now() < armedBlock.until;
  const approve = person.status !== 'approved' ? `<button class="btn" data-approve="${escapeHtml(person.id)}">${person.status === 'blocked' ? 'UNBLOCK' : 'LET IN'}</button>` : '';
  const block = person.status !== 'blocked' && !person.admin ? `<button class="btn danger" data-block="${escapeHtml(person.id)}">${armed ? 'SURE? BLOCK' : 'BLOCK'}</button>` : '';
  return `<tr><td>${crown}${escapeHtml(person.login)}${name}</td><td>${how}</td><td>${person.clans}</td><td>${person.macs}</td>`
    + `<td>${ago(person.lastLogin)}</td><td class="end">${approve} ${block}</td></tr>`;
}

function peopleGroup(title, people) {
  if (!people.length) return '';
  return `<div class="group"><div class="label">${title} (${people.length})</div><table>`
    + `<tr><th>PERSON</th><th>ACCESS</th><th>CLANS</th><th>MACS</th><th>LAST SIGN-IN</th><th class="end"></th></tr>${people.map(personRow).join('')}</table></div>`;
}

async function renderPeople() {
  const result = await call('GET', '/api/admin/users');
  const people = result ? result.users : [];
  document.getElementById('people').innerHTML = peopleGroup('WAITING FOR YOU', people.filter((p) => p.status === 'pending' && !p.admin))
    + peopleGroup('LET IN', people.filter((p) => p.status === 'approved' || p.admin))
    + peopleGroup('BLOCKED', people.filter((p) => p.status === 'blocked' && !p.admin));
}

function show(view) {
  for (const id of ['signedOut', 'waiting', 'signedIn']) document.getElementById(id).hidden = id !== view;
  document.getElementById('who').hidden = view === 'signedOut';
}

// Someone waiting for approval sees the page change by itself once they are let in.
function waitForApproval() {
  clearTimeout(waitingTimer);
  waitingTimer = setTimeout(load, WAITING_REFRESH_MS);
}

async function load() {
  const response = await fetch('/api/me');
  if (response.status === 401) {
    const join = params.get('join');
    document.getElementById('signIn').href = `/auth/login?next=${encodeURIComponent(join ? `/?join=${join}` : '/')}`;
    show('signedOut');
    return;
  }
  me = await response.json();
  document.getElementById('login').textContent = `@${me.user.login}`;
  const avatar = document.getElementById('avatar');
  avatar.hidden = !me.user.avatarUrl;
  if (me.user.avatarUrl) avatar.src = me.user.avatarUrl;
  if (me.user.status !== 'approved' && !me.user.admin) {
    document.getElementById('waitingLogin').textContent = `@${me.user.login}`;
    document.getElementById('waitingAdmins').textContent = me.admins.length ? ` (${me.admins.join(', ')})` : '';
    show('waiting');
    waitForApproval();
    return;
  }
  show('signedIn');
  document.getElementById('adminCard').hidden = !me.user.admin;
  document.getElementById('login').textContent = `@${me.user.login}`;
  document.getElementById('hubAddress').textContent = location.origin;
  await Promise.all([renderClans(), renderDevices(), me.user.admin ? renderPeople() : null]);
}

document.getElementById('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('createName');
  const result = await call('POST', '/api/clans', { name: input.value });
  if (!result) return;
  input.value = '';
  toast(result.message);
  load();
});

document.getElementById('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('joinCode');
  const result = await call('POST', '/api/join', { code: input.value });
  if (!result) return;
  input.value = '';
  history.replaceState(null, '', '/');
  toast(result.message);
  load();
});

document.getElementById('signOut').addEventListener('click', async () => {
  await call('POST', '/auth/logout', {});
  load();
});

document.addEventListener('click', async (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  const { copy, reset, leave, remove, clan, unlink, approve, block } = button.dataset;
  if (approve) {
    const result = await call('POST', `/api/admin/users/${encodeURIComponent(approve)}/approve`, {});
    if (result) toast(result.message);
    renderPeople();
  } else if (block) {
    if (armedBlock.userId !== block || Date.now() > armedBlock.until) {
      armedBlock = { userId: block, until: Date.now() + LEAVE_CONFIRM_MS };
      renderPeople();
      setTimeout(renderPeople, LEAVE_CONFIRM_MS);
      return;
    }
    armedBlock = { userId: '', until: 0 };
    const result = await call('POST', `/api/admin/users/${encodeURIComponent(block)}/block`, {});
    if (result) toast(result.message);
    load();
  } else if (copy) {
    const link = `${location.origin}/?join=${copy}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch {
      toast(`Copy this link: ${link}`);
    }
  } else if (reset) {
    const result = await call('POST', `/api/clans/${encodeURIComponent(reset)}/invite/reset`, {});
    if (result) toast(result.message);
    renderClans();
  } else if (leave) {
    // A second click within a few seconds confirms, so one stray click never drops you from a clan.
    if (armedLeave.clanId !== leave || Date.now() > armedLeave.until) {
      armedLeave = { clanId: leave, until: Date.now() + LEAVE_CONFIRM_MS };
      renderClans();
      setTimeout(renderClans, LEAVE_CONFIRM_MS);
      return;
    }
    armedLeave = { clanId: '', until: 0 };
    const result = await call('POST', `/api/clans/${encodeURIComponent(leave)}/leave`, {});
    if (result) toast(result.message);
    load();
  } else if (remove) {
    const result = await call('POST', `/api/clans/${encodeURIComponent(clan)}/members/${encodeURIComponent(remove)}/remove`, {});
    if (result) toast(result.message);
    renderClans();
  } else if (unlink) {
    const result = await call('POST', `/api/devices/${encodeURIComponent(unlink)}/revoke`, {});
    if (result) toast(result.message);
    renderDevices();
  }
});

if (params.get('join')) document.getElementById('joinCode').value = params.get('join');
if (ERRORS[params.get('error')]) toast(ERRORS[params.get('error')], '');
load();
