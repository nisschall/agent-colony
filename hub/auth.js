// Who is calling: GitHub sign-in for browsers (a signed session cookie), and device tokens for linked Macs.
const crypto = require('crypto');
const { ApiError } = require('./api-error');

const SESSION_COOKIE = 'hub_session';
const OAUTH_COOKIE = 'hub_oauth';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_MS = 10 * 60 * 1000;
const LINK_CODE_MS = 2 * 60 * 1000;
// Only a colony on the same machine as the browser may receive a link code.
const LOCAL_CALLBACK = /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/clan\/linked$/;
const USER_AGENT = 'agent-colony-hub';

const WAITING = 'Your account is waiting for a hub admin to approve it.';

function createAuth(config, store) {
  const linkCodes = new Map();
  const secret = store.sessionSecret();

  function sign(value) {
    const mac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
    return `${value}.${mac}`;
  }

  function unsign(signed) {
    const dot = String(signed || '').lastIndexOf('.');
    if (dot < 1) return null;
    const value = signed.slice(0, dot);
    const expected = Buffer.from(sign(value));
    const given = Buffer.from(signed);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    return value;
  }

  function sealed(payload) {
    return sign(Buffer.from(JSON.stringify(payload)).toString('base64url'));
  }

  function opened(cookie) {
    const value = unsign(cookie);
    if (!value) return null;
    try {
      const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      return payload.exp > Date.now() ? payload : null;
    } catch {
      return null;
    }
  }

  function cookie(name, value, maxAgeMs) {
    const secure = config.secureCookies ? '; Secure' : '';
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
  }

  function cookiesOf(req) {
    const jar = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return jar;
  }

  function isAdmin(user) {
    return Boolean(user) && config.admins.includes(user.login.toLowerCase());
  }

  function mayUseHub(user) {
    return Boolean(user) && (user.status === 'approved' || isAdmin(user));
  }

  // Looked up on every request, so blocking someone signs them out everywhere at once.
  function sessionUser(req) {
    const session = opened(cookiesOf(req)[SESSION_COOKIE]);
    const user = session ? store.userOf(session.uid) : null;
    return user && user.status !== 'blocked' ? { ...user, admin: isAdmin(user) } : null;
  }

  // Signed in, whether or not approved yet: only for seeing your own status and signing out.
  function requireUser(req) {
    const user = sessionUser(req);
    if (!user) throw new ApiError(401, 'Sign in with GitHub first.');
    return user;
  }

  function requireApproved(req) {
    const user = requireUser(req);
    if (!mayUseHub(user)) throw new ApiError(403, WAITING);
    return user;
  }

  function requireAdmin(req) {
    const user = requireApproved(req);
    if (!user.admin) throw new ApiError(403, 'Only a hub admin can do that.');
    return user;
  }

  function bearerDevice(req) {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return null;
    const device = store.deviceByToken(header.slice('Bearer '.length).trim());
    return device && mayUseHub(store.userOf(device.userId)) ? device : null;
  }

  function requireDevice(req) {
    const device = bearerDevice(req);
    if (!device) throw new ApiError(401, 'This Mac is not linked any more. Link it again from your town.');
    return device;
  }

  // A browser session or a linked Mac's token, for the calls both may make.
  function requireCaller(req) {
    const device = bearerDevice(req);
    if (device) {
      const user = store.userOf(device.userId);
      return { ...user, admin: isAdmin(user) };
    }
    return requireUser(req);
  }

  // Only relative paths, so the sign-in can't be used to bounce people to another site.
  function safeNext(next) {
    const value = String(next || '/');
    return value.startsWith('/') && !value.startsWith('//') ? value : '/';
  }

  function loginRedirect(next) {
    if (!config.githubClientId) throw new ApiError(500, 'GitHub sign-in is not set up on this hub (GITHUB_CLIENT_ID is missing).');
    const state = crypto.randomBytes(16).toString('base64url');
    // Org membership can only be read with read:org; without an org to check, the hub asks for nothing extra.
    const params = new URLSearchParams({
      client_id: config.githubClientId,
      redirect_uri: `${config.hubUrl}/auth/callback`,
      state,
      scope: config.autoApproveOrg ? 'read:org' : '',
      allow_signup: 'true',
    });
    return {
      location: `${config.githubUrl}/login/oauth/authorize?${params}`,
      setCookie: cookie(OAUTH_COOKIE, sealed({ state, next: safeNext(next), exp: Date.now() + OAUTH_MS }), OAUTH_MS),
    };
  }

  async function githubUser(code) {
    const tokenResponse = await fetch(`${config.githubUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code,
        redirect_uri: `${config.hubUrl}/auth/callback`,
      }),
    });
    const tokenBody = await tokenResponse.json();
    if (!tokenBody.access_token) throw new ApiError(401, 'GitHub did not accept the sign-in. Try again.');
    const userResponse = await fetch(`${config.githubApiUrl}/user`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tokenBody.access_token}`, 'User-Agent': USER_AGENT },
    });
    if (!userResponse.ok) throw new ApiError(502, 'Could not read your GitHub profile. Try again.');
    return { profile: await userResponse.json(), token: tokenBody.access_token };
  }

  async function activeOrgMember(token) {
    const response = await fetch(`${config.githubApiUrl}/user/memberships/orgs/${encodeURIComponent(config.autoApproveOrg)}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
    });
    if (!response.ok) return false;
    const membership = await response.json();
    return membership.state === 'active';
  }

  // Admins are always in. Otherwise the org lets people in, and takes back what it gave if they leave it;
  // someone an admin approved stays approved until an admin blocks them.
  async function decideAccess(user, token) {
    if (isAdmin(user)) {
      if (user.status !== 'approved') store.setUserStatus(user.id, 'approved', 'admin');
      return;
    }
    if (!config.autoApproveOrg || !(user.status === 'pending' || user.approvedBy === 'org')) return;
    const member = await activeOrgMember(token);
    if (member) store.setUserStatus(user.id, 'approved', 'org');
    else if (user.approvedBy === 'org') store.setUserStatus(user.id, 'pending');
  }

  // The GitHub access token is used during sign-in only, and never stored.
  async function finishLogin(req, query) {
    const pending = opened(cookiesOf(req)[OAUTH_COOKIE]);
    if (!pending || !query.get('state') || pending.state !== query.get('state')) {
      throw new ApiError(400, 'The sign-in expired or came from somewhere else. Start again.');
    }
    const { profile, token } = await githubUser(query.get('code'));
    const known = store.userOf(`gh:${profile.id}`);
    if (known && known.status === 'blocked' && !isAdmin(known)) {
      return { location: '/?error=blocked', setCookies: [cookie(OAUTH_COOKIE, '', 0)] };
    }
    const user = store.upsertUser(profile);
    await decideAccess(user, token);
    return {
      location: pending.next,
      setCookies: [
        cookie(SESSION_COOKIE, sealed({ uid: user.id, exp: Date.now() + SESSION_MS }), SESSION_MS),
        cookie(OAUTH_COOKIE, '', 0),
      ],
    };
  }

  function logoutCookie() {
    return cookie(SESSION_COOKIE, '', 0);
  }

  // Step one of linking a Mac: a short-lived, single-use code sent back to that Mac's own colony.
  function linkRedirect(user, callback, state) {
    if (!LOCAL_CALLBACK.test(String(callback || ''))) throw new ApiError(400, 'Links can only go back to a colony on this computer.');
    if (!state) throw new ApiError(400, 'The link request is missing its state. Start again from your town.');
    const now = Date.now();
    for (const [unused, pending] of linkCodes) {
      if (pending.exp < now) linkCodes.delete(unused);
    }
    const code = crypto.randomBytes(24).toString('base64url');
    linkCodes.set(code, { userId: user.id, exp: Date.now() + LINK_CODE_MS });
    const params = new URLSearchParams({ code, state, hub: config.hubUrl });
    return `${callback}?${params}`;
  }

  // Step two: the colony trades the code for its own device token.
  function exchangeLinkCode(code, label) {
    const pending = linkCodes.get(String(code || ''));
    linkCodes.delete(String(code || ''));
    if (!pending || pending.exp < Date.now()) throw new ApiError(400, 'That link code has expired. Link again from your town.');
    const { token, device } = store.addDevice(pending.userId, label);
    return { token, deviceId: device.id, user: store.userOf(pending.userId) };
  }

  return {
    isAdmin, mayUseHub, sessionUser, requireUser, requireApproved, requireAdmin, requireDevice, requireCaller,
    loginRedirect, finishLogin, logoutCookie, linkRedirect, exchangeLinkCode,
  };
}

module.exports = { createAuth };
