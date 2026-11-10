// Agent Colony server: serves the page, streams colony state, and handles the town's actions.
// Run: npm start (or node server/index.js), then open http://localhost:4747
const fs = require('fs');
const path = require('path');
const http = require('http');
const { agents } = require('./agents');
const { ApiError } = require('./api-error');
const { API_TOKEN, PORT, PUBLIC_DIR } = require('./config');
const { clanStatus, finishLink, setShares, startLink, startPushing, unlink } = require('./clan');
const { conversationOf } = require('./conversation');
const { foundProject, hireAgent, openInTerminal, releaseAgent, retryBlocked, sendOrders, stopAgent } = require('./portal');
const { discover, files, poll } = require('./scanner');
const { snapshot } = require('./snapshot');
const { currentTownSeed, rebuildTown } = require('./town');

let initialScanDone = false;
const clients = new Set();
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot(initialScanDone))}\n\n`;
  for (const res of clients) res.write(payload);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20_000) reject(new ApiError(413, 'Message too long.'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new ApiError(400, 'Invalid JSON.')); }
    });
  });
}

function isTrustedApiCall(req) {
  const origin = req.headers.origin;
  const sameOrigin = !origin || ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''));
  return sameOrigin && req.headers['x-colony-token'] === API_TOKEN && req.headers['content-type'] === 'application/json';
}

async function handleApi(req, res) {
  if (req.method !== 'POST' || !isTrustedApiCall(req)) throw new ApiError(403, 'Not allowed.');
  const body = await readJson(req);
  if (req.url === '/api/hire') {
    const agentId = hireAgent(body);
    return sendJson(res, 200, { ok: true, message: 'Agent hired.', agentId });
  }
  if (req.url === '/api/found') {
    const agentId = foundProject(body);
    return sendJson(res, 200, { ok: true, message: 'Project started.', agentId });
  }
  if (req.url === '/api/clan/status') return sendJson(res, 200, { ok: true, message: '', agentId: null, ...(await clanStatus()) });
  if (req.url === '/api/clan/link') return sendJson(res, 200, { ok: true, message: 'Sign in on the hub to link this Mac.', agentId: null, url: startLink(body.hub) });
  if (req.url === '/api/clan/unlink') {
    await unlink();
    return sendJson(res, 200, { ok: true, message: 'This Mac is no longer linked to the hub.', agentId: null });
  }
  if (req.url === '/api/clan/shares') {
    const shares = setShares(body.project, body.clans);
    return sendJson(res, 200, { ok: true, message: 'Sharing updated.', agentId: null, shares });
  }
  if (req.url === '/api/town/rebuild') {
    rebuildTown(body.seed);
    broadcast();
    return sendJson(res, 200, { ok: true, message: 'Town rebuilt.' });
  }
  const match = req.url.match(/^\/api\/agents\/([^/]+)\/(orders|retry|stop|release|terminal|conversation)$/);
  if (!match) throw new ApiError(404, 'Unknown endpoint.');
  const agentId = decodeURIComponent(match[1]);
  const action = match[2];
  if (action === 'terminal') {
    await openInTerminal(agentId);
    return sendJson(res, 200, { ok: true, message: 'Opened in Terminal.', agentId });
  }
  if (action === 'conversation') return sendJson(res, 200, { ok: true, message: '', agentId, ...conversationOf(agentId) });
  if (action === 'orders') sendOrders(agentId, body.message);
  else if (action === 'retry') retryBlocked(agentId);
  else if (action === 'release') releaseAgent(agentId);
  else stopAgent(agentId);
  broadcast();
  return sendJson(res, 200, { ok: true, message: ACTION_MESSAGES[action], agentId });
}

const ACTION_MESSAGES = { orders: 'Orders sent.', retry: 'Retrying with your approval.', stop: 'Agent stopped.', release: 'Agent released.' };

const STATIC_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// Serves the page's scripts and stylesheet from public/, and nothing outside it.
function serveStatic(pathname, res) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  const type = STATIC_TYPES[path.extname(file)];
  if (!type || !file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
  return true;
}

const server = http.createServer((req, res) => {
  // Reject requests addressed to any other host name (guards against DNS rebinding).
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (req.url.startsWith('/api/')) {
    handleApi(req, res).catch((err) => sendJson(res, err.status || 500, { ok: false, message: err.message, agentId: null }));
    return;
  }
  // Small read-only summary for the menu-bar wallpaper app's badge.
  if (req.url === '/status') {
    const current = snapshot(initialScanDone);
    const status = { waiting: 0, working: 0, overworked: 0, stuck: 0, idle: 0, sleeping: 0, costToday: current.totals.costToday, waitingAgents: [] };
    for (const agent of current.agents) {
      status[agent.status] += 1;
      if (agent.status === 'waiting') {
        status.waitingAgents.push({ id: agent.id, project: agent.project, ask: agent.waitingAsk, waitingSince: agent.waitingSince });
      }
    }
    status.waitingAgents.sort((a, b) => a.waitingSince - b.waitingSince);
    return sendJson(res, 200, status);
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    res.write(`data: ${JSON.stringify(snapshot(initialScanDone))}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }
  const pathname = req.url.split('?')[0];
  if (pathname === '/' || pathname === '/index.html') {
    let template;
    try {
      template = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    } catch (error) {
      console.error(`Could not read the page: ${error.message}`);
  // The hub sends the browser back here after you sign in, to finish linking this Mac.
  if (pathname === '/clan/linked') {
    const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
    finishLink(query)
      .then(() => {
        res.writeHead(302, { Location: '/?clan=linked' });
        res.end();
      })
      .catch((error) => {
        res.writeHead(error.status || 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Could not link this Mac: ${error.message}`);
      });
    return;
  }
      res.writeHead(500);
      res.end();
      return;
    }
    const page = template
      .replace('__COLONY_TOKEN__', API_TOKEN)
      .replace('__COLONY_LAYOUT__', String(currentTownSeed()))
      .replace('__COLONY_CLAN__', '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
    return;
  }
  if (serveStatic(pathname, res)) return;
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Colony running at http://localhost:${PORT}`);
  const started = Date.now();
  discover();
  poll();
  initialScanDone = true;
  console.log(`Scanned ${files.size} logs (${agents.size} agents) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  setInterval(() => { poll(); broadcast(); }, 2000);
  setInterval(discover, 15000);
});
  startPushing();
