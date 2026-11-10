// A stand-in for GitHub's sign-in, for tests and for trying the hub without a GitHub OAuth App.
// The sign-in page signs you straight in as the login in ?as= (default alice).
const http = require('http');

const USERS = {
  alice: { id: 1, login: 'alice', name: 'Alice', avatar_url: '' },
  bob: { id: 2, login: 'bob', name: 'Bob', avatar_url: '' },
  carol: { id: 3, login: 'carol', name: 'Carol', avatar_url: '' },
  dave: { id: 4, login: 'dave', name: 'Dave', avatar_url: '' },
  erin: { id: 5, login: 'erin', name: 'Erin', avatar_url: '' },
};
// GitHub organisations and their active members, for org auto-approve.
const ORGS = { acme: ['dave'] };

function startFakeGithub(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/login/oauth/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', url.searchParams.get('as') || 'alice');
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/login/oauth/access_token') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const { code } = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(USERS[code] ? { access_token: `tok-${code}` } : { error: 'bad_verification_code' }));
      });
      return undefined;
    }
    const membership = url.pathname.match(/^\/user\/memberships\/orgs\/([^/]+)$/);
    if (membership) {
      const login = String(req.headers.authorization || '').replace('Bearer tok-', '');
      const member = (ORGS[membership[1]] || []).includes(login);
      res.writeHead(member ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(member ? { state: 'active', role: 'member' } : { message: 'Not Found' }));
    }
    if (url.pathname === '/user') {
      const login = String(req.headers.authorization || '').replace('Bearer tok-', '');
      res.writeHead(USERS[login] ? 200 : 401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(USERS[login] || { message: 'Bad credentials' }));
    }
    res.writeHead(404);
    return res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (require.main === module) {
  startFakeGithub(Number(process.env.PORT || 4801)).then((s) => console.log(`Fake GitHub on http://127.0.0.1:${s.address().port}`));
}

module.exports = { startFakeGithub };
