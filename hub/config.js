// Hub settings, read from the environment. Kept in one object so tests can start a hub with their own.
const path = require('path');

function loadConfig(env = process.env) {
  const hubUrl = String(env.HUB_URL || `http://localhost:${env.PORT || 4800}`).replace(/\/+$/, '');
  return {
    port: Number(env.PORT || 4800),
    host: env.HOST || '0.0.0.0',
    hubUrl,
    secureCookies: hubUrl.startsWith('https://'),
    dbFile: env.DB_FILE || path.join(__dirname, 'hub.db'),
    // Where an older hub kept its data; imported into the database once, then renamed.
    legacyDataFile: env.DATA_FILE || path.join(__dirname, 'hub-data.json'),
    // GitHub logins that run the hub: always let in, and the only ones who can approve or block people.
    admins: String(env.HUB_ADMINS || '').split(',').map((login) => login.trim().toLowerCase()).filter(Boolean),
    // Members of this GitHub organisation are let in without waiting for approval.
    autoApproveOrg: String(env.HUB_AUTO_APPROVE_ORG || '').trim(),
    // The town page and its scripts, shared with the colony so a clan's town looks and plays the same.
    publicDir: env.PUBLIC_DIR || path.join(__dirname, '..', 'public'),
    githubClientId: env.GITHUB_CLIENT_ID || '',
    githubClientSecret: env.GITHUB_CLIENT_SECRET || '',
    // Overridable for GitHub Enterprise, and for tests.
    githubUrl: String(env.GITHUB_URL || 'https://github.com').replace(/\/+$/, ''),
    githubApiUrl: String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  };
}

module.exports = { loadConfig };
