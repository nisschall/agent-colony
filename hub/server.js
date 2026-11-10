// Agent Colony hub: GitHub sign-in, clans, linked Macs, and each clan's combined town.
// Run: GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… HUB_URL=https://your-hub node server.js
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ApiError } = require('./api-error');
const { createAuth } = require('./auth');
const { loadConfig } = require('./config');
const { createStore } = require('./store');
const { createTown } = require('./town');

const SMALL_BODY = 10_000;
const REPORT_BODY = 1_000_000;
const STREAM_MS = 2000;
const JSON_TYPE = 'application/json';
const PAGES_DIR = path.join(__dirname, 'pages');
const STATIC_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': JSON_TYPE });
  res.end(JSON.stringify(body));
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { Location: location, 'Set-Cookie': cookies });
  res.end();
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new ApiError(413, 'Request too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new ApiError(400, 'Invalid JSON.')); }
    });
  });
}

// Serves one file from `dir`, and nothing outside it.
function serveFile(res, dir, relative) {
  const file = path.normalize(path.join(dir, relative));
  const type = STATIC_TYPES[path.extname(file)];
  if (!type || !file.startsWith(dir + path.sep) || !fs.existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(file));
  return true;
}

// Each clan gets its own town layout, the same for every member.
function layoutSeed(clanId) {
  return parseInt(crypto.createHash('sha256').update(clanId).digest('hex').slice(0, 7), 16) + 1;
}

function clanSummary(clan, userId) {
  return { id: clan.id, name: clan.name, role: clan.members[userId].role, members: Object.keys(clan.members).length };
}

function startHub(config) {
  const store = createStore(config.dbFile);
  if (store.importJson(config.legacyDataFile)) console.log(`Imported ${config.legacyDataFile} into ${config.dbFile}`);
  const auth = createAuth(config, store);
  const town = createTown(store);
  const hubOrigin = new URL(config.hubUrl).origin;
  const streams = new Map();

  function clanView(clan) {
    const members = Object.entries(clan.members).map(([userId, member]) => {
      const user = store.userOf(userId) || {};
      return { login: user.login, name: user.name, avatarUrl: user.avatarUrl, role: member.role, joinedAt: member.joinedAt };
    });
    return { id: clan.id, name: clan.name, createdAt: clan.createdAt, inviteCode: clan.inviteCode, members };
  }

  function memberIdByLogin(clan, login) {
    const userId = Object.keys(clan.members).find((id) => store.userOf(id)?.login === login);
    if (!userId) throw new ApiError(404, 'That person is not in the clan.');
    return userId;
  }

  // Browsers send JSON only from the hub's own pages; a form post from another site is refused.
  function checkPost(req) {
    const origin = req.headers.origin;
    if (origin && origin !== hubOrigin) throw new ApiError(403, 'Not allowed from another site.');
    if (!String(req.headers['content-type'] || '').startsWith(JSON_TYPE)) throw new ApiError(415, 'Send JSON.');
  }

  function openStream(req, res, clan, user) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(town.townOf(clan))}\n\n`);
    const listeners = streams.get(clan.id) || new Set();
    const listener = { res, userId: user.id };
    listeners.add(listener);
    streams.set(clan.id, listeners);
    req.on('close', () => listeners.delete(listener));
  }

  // One town per clan per tick, shared by everyone watching it; someone who left the clan stops receiving it.
  function pushStreams() {
    for (const [clanId, listeners] of streams) {
      if (!listeners.size) {
        streams.delete(clanId);
        continue;
      }
      let payload = '';
      for (const listener of listeners) {
        let clan;
        try {
          clan = store.memberClan(clanId, listener.userId);
        } catch {
          listener.res.end();
          listeners.delete(listener);
          continue;
        }
        payload = payload || `data: ${JSON.stringify(town.townOf(clan))}\n\n`;
        listener.res.write(payload);
      }
    }
  }

  async function handleApi(req, res, url) {
    const { pathname } = url;
    if (req.method === 'POST') checkPost(req);

    if (req.method === 'POST' && pathname === '/api/link/exchange') {
      const body = await readJson(req, SMALL_BODY);
      const linked = auth.exchangeLinkCode(body.code, body.label);
      return sendJson(res, 200, { ok: true, message: 'This Mac is linked.', ...linked });
    }
    if (req.method === 'POST' && pathname === '/api/report') {
      const device = auth.requireDevice(req);
      const body = await readJson(req, REPORT_BODY);
      store.touchDevice(device);
      const kept = town.receiveReport(device.userId, body);
      return sendJson(res, 200, { ok: true, message: 'Report received.', ...kept });
    }
    if (req.method === 'POST' && pathname === '/api/devices/self/revoke') {
      const device = auth.requireDevice(req);
      store.revokeDevice(device.userId, device.id);
      return sendJson(res, 200, { ok: true, message: 'This Mac is unlinked.' });
    }
    if (req.method === 'GET' && pathname === '/api/me') {
      const user = auth.requireCaller(req);
      const clans = store.clansOf(user.id).map((clan) => clanSummary(clan, user.id));
      return sendJson(res, 200, { ok: true, message: '', user, clans, admins: config.admins });
    }

    if (pathname.startsWith('/api/admin/')) return handleAdmin(req, res, pathname);
    const user = auth.requireApproved(req);
    if (req.method === 'GET' && pathname === '/api/devices') {
      return sendJson(res, 200, { ok: true, message: '', devices: store.devicesOf(user.id) });
    }
    const revoke = pathname.match(/^\/api\/devices\/([\w-]+)\/revoke$/);
    if (req.method === 'POST' && revoke) {
      store.revokeDevice(user.id, revoke[1]);
      return sendJson(res, 200, { ok: true, message: 'That Mac is unlinked.' });
    }
    if (req.method === 'POST' && pathname === '/api/clans') {
      const body = await readJson(req, SMALL_BODY);
      const clan = store.createClan(user.id, body.name);
      return sendJson(res, 200, { ok: true, message: `Clan ${clan.name} created.`, clan: clanView(clan) });
    }
    if (req.method === 'POST' && pathname === '/api/join') {
      const body = await readJson(req, SMALL_BODY);
      const clan = store.joinClan(user.id, body.code);
      return sendJson(res, 200, { ok: true, message: `You joined ${clan.name}.`, clan: clanView(clan) });
    }

    const match = pathname.match(/^\/api\/clans\/([\w-]+)(\/.*)?$/);
    if (!match) throw new ApiError(404, 'Unknown endpoint.');
    const clan = store.memberClan(match[1], user.id);
    const action = match[2] || '';
    if (req.method === 'GET' && action === '') return sendJson(res, 200, { ok: true, message: '', clan: clanView(clan) });
    if (req.method === 'GET' && action === '/town') return sendJson(res, 200, { ok: true, message: '', town: town.townOf(clan) });
    if (req.method === 'GET' && action === '/stream') return openStream(req, res, clan, user);
    if (req.method === 'POST' && action === '/leave') {
      store.leaveClan(clan.id, user.id);
      return sendJson(res, 200, { ok: true, message: `You left ${clan.name}.` });
    }
    if (req.method === 'POST' && action === '/invite/reset') {
      const updated = store.resetInvite(clan.id, user.id);
      return sendJson(res, 200, { ok: true, message: 'New invite code made; the old one no longer works.', clan: clanView(updated) });
    }
    const remove = action.match(/^\/members\/([\w-]+)\/remove$/);
    if (req.method === 'POST' && remove) {
      store.kickMember(clan.id, user.id, memberIdByLogin(clan, remove[1]));
      return sendJson(res, 200, { ok: true, message: `${remove[1]} was removed from ${clan.name}.` });
    }
    throw new ApiError(404, 'Unknown endpoint.');
  }

  // Hub admins (HUB_ADMINS) let people in, block them, and let them back in.
  function handleAdmin(req, res, pathname) {
    const admin = auth.requireAdmin(req);
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      const users = store.listUsers().map((user) => ({ ...user, admin: auth.isAdmin(user) }));
      return sendJson(res, 200, { ok: true, message: '', users });
    }
    const match = pathname.match(/^\/api\/admin\/users\/([^/]+)\/(approve|block|unblock)$/);
    if (req.method !== 'POST' || !match) throw new ApiError(404, 'Unknown endpoint.');
    // Ids look like gh:123, which browsers send encoded (gh%3A123).
    const target = store.userOf(decodeURIComponent(match[1]));
    if (!target) throw new ApiError(404, 'No such user.');
    const action = match[2];
    if (action === 'block') {
      if (auth.isAdmin(target) || target.id === admin.id) throw new ApiError(400, 'A hub admin cannot be blocked. Remove them from HUB_ADMINS first.');
      store.blockUser(target.id);
      console.log(`${admin.login} blocked ${target.login}`);
      return sendJson(res, 200, { ok: true, message: `${target.login} is blocked: signed out, unlinked and removed from every clan.` });
    }
    store.setUserStatus(target.id, 'approved', 'admin');
    console.log(`${admin.login} let ${target.login} in`);
    return sendJson(res, 200, { ok: true, message: `${target.login} can use the hub now.` });
  }

  async function handlePage(req, res, url) {
    const { pathname, searchParams } = url;
    if (pathname === '/auth/login') {
      const { location, setCookie } = auth.loginRedirect(searchParams.get('next'));
      return redirect(res, location, [setCookie]);
    }
    if (pathname === '/auth/callback') {
      const { location, setCookies } = await auth.finishLogin(req, searchParams);
      return redirect(res, location, setCookies);
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
      checkPost(req);
      res.writeHead(200, { 'Content-Type': JSON_TYPE, 'Set-Cookie': auth.logoutCookie() });
      return res.end(JSON.stringify({ ok: true, message: 'Signed out.' }));
    }
    if (pathname === '/link') {
      const user = auth.sessionUser(req);
      if (!user) return redirect(res, `/auth/login?next=${encodeURIComponent(pathname + url.search)}`);
      if (!auth.mayUseHub(user)) return redirect(res, '/?error=waiting');
      return redirect(res, auth.linkRedirect(user, searchParams.get('callback'), searchParams.get('state')));
    }
    if (pathname === '/' && serveFile(res, PAGES_DIR, 'home.html')) return undefined;
    if (pathname === '/home.js' && serveFile(res, PAGES_DIR, 'home.js')) return undefined;
    const clanPage = pathname.match(/^\/clans\/([\w-]+)$/);
    if (clanPage) return serveClanTown(req, res, clanPage[1], pathname);
    if ((pathname === '/styles.css' || pathname === '/icons.svg' || pathname.startsWith('/js/')) && serveFile(res, config.publicDir, pathname)) return undefined;
    throw new ApiError(404, 'Not found.');
  }

  // The colony's own town page, told to show this clan: no API token (it is watch-only) and the clan's layout.
  function serveClanTown(req, res, clanId, pathname) {
    const user = auth.sessionUser(req);
    if (!user) return redirect(res, `/auth/login?next=${encodeURIComponent(pathname)}`);
    if (!auth.mayUseHub(user)) return redirect(res, '/?error=waiting');
    let clan;
    try {
      clan = store.memberClan(clanId, user.id);
    } catch {
      return redirect(res, '/?error=notmember');
    }
    const page = fs.readFileSync(path.join(config.publicDir, 'index.html'), 'utf8')
      .replace('__COLONY_TOKEN__', '')
      .replace('__COLONY_LAYOUT__', String(layoutSeed(clan.id)))
      .replace('__COLONY_CLAN__', clan.id);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page);
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, config.hubUrl);
    const handler = url.pathname.startsWith('/api/') ? handleApi : handlePage;
    handler(req, res, url).catch((error) => {
      if (!error.status) console.error(`Hub error on ${url.pathname}: ${error.message}`);
      if (res.headersSent) return res.end();
      return sendJson(res, error.status || 500, { ok: false, message: error.status ? error.message : 'Something went wrong on the hub.' });
    });
  });

  const ticker = setInterval(pushStreams, STREAM_MS);
  server.on('close', () => {
    clearInterval(ticker);
    store.close();
  });
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => resolve(server));
  });
}

if (require.main === module) {
  const config = loadConfig();
  if (!config.githubClientId || !config.githubClientSecret) {
    console.warn('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set: nobody can sign in until they are.');
  }
  startHub(config).then(() => console.log(`Agent Colony hub running at ${config.hubUrl} (port ${config.port})`));
}

module.exports = { startHub };
