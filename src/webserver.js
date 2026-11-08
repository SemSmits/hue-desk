'use strict';

/**
 * Optional web server so Hue Desk can be controlled from a browser on the local network.
 *
 * Security model (LAN only, plain HTTP):
 * - Password login, stored as a salted scrypt hash, compared in constant time
 * - Random session token in an HttpOnly, SameSite=Strict cookie
 * - Login rate limiting per IP with an increasing lockout
 * - API calls need a custom header (blocks cross-site form posts) and must use a whitelisted channel
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const COOKIE = 'huedesk_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const MIN_PASSWORD = 6;

const STATIC_FILES = {
  '/styles.css': ['renderer', 'styles.css', 'text/css'],
  '/app.js': ['renderer', 'app.js', 'application/javascript'],
  '/web-shim.js': ['web', 'web-shim.js', 'application/javascript'],
  '/login': ['web', 'login.html', 'text/html'],
  '/login.js': ['web', 'login.js', 'application/javascript'],
  '/login.css': ['web', 'login.css', 'text/css'],
};

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  }
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, stored) {
  if (!stored || !stored.salt || !stored.hash || typeof password !== 'string') return false;
  const actual = crypto.scryptSync(password, stored.salt, 64);
  const expected = Buffer.from(stored.hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function lanAddresses(interfaces = os.networkInterfaces()) {
  return Object.values(interfaces)
    .flat()
    .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
    .map((i) => i.address);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim().split('=')).filter(([k, v]) => k && v).map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {() => {salt: string, hash: string} | null} opts.getPassword  stored password hash
 * @param {Record<string, Function>} opts.handlers  same handlers as the IPC channels
 * @param {Set<string>} opts.allowedChannels  channels the browser may call
 * @param {string} opts.srcDir  path to src/ (contains renderer/ and web/)
 */
function createWebServer({ getPassword, handlers, allowedChannels, srcDir, now = () => Date.now() }) {
  const sessions = new Map(); // token -> expiresAt
  const failures = new Map(); // ip -> { count, lockedUntil }
  const sseClients = new Set();
  let server = null;
  let keepAlive = null;

  const isAuthed = (req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const exp = token && sessions.get(token);
    if (!exp) return false;
    if (exp < now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  };

  const send = (res, status, body, type = 'application/json', extra = {}) => {
    res.writeHead(status, {
      'Content-Type': `${type}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  const readStatic = (dir, file) => fs.readFileSync(path.join(srcDir, dir, file), 'utf8');

  async function handleLogin(req, res) {
    const ip = req.socket.remoteAddress || 'unknown';
    const f = failures.get(ip) || { count: 0, lockedUntil: 0 };
    if (f.lockedUntil > now()) {
      return send(res, 429, { ok: false, error: `Too many attempts, try again in ${Math.ceil((f.lockedUntil - now()) / 1000)}s` });
    }
    const body = await readJson(req);
    if (!verifyPassword(body.password, getPassword())) {
      f.count += 1;
      // 5 free attempts, then 30s, 60s, 120s ... capped at 15 minutes
      if (f.count >= 5) f.lockedUntil = now() + Math.min(15 * 60, 30 * 2 ** (f.count - 5)) * 1000;
      failures.set(ip, f);
      return send(res, 401, { ok: false, error: 'Wrong password' });
    }
    failures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, now() + SESSION_TTL_MS);
    return send(res, 200, { ok: true }, 'application/json', {
      'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    });
  }

  async function handleInvoke(req, res) {
    if (req.headers['x-hue-desk'] !== '1') return send(res, 403, { ok: false, error: 'Missing request header' });
    const { channel, args = [] } = await readJson(req);
    if (!allowedChannels.has(channel) || typeof handlers[channel] !== 'function') {
      return send(res, 403, { ok: false, error: `Channel not allowed: ${channel}` });
    }
    try {
      const data = await handlers[channel](...(Array.isArray(args) ? args : []));
      return send(res, 200, { ok: true, data: data === undefined ? null : data });
    } catch (err) {
      return send(res, 200, { ok: false, error: err.message, type: err.type });
    }
  }

  function handleEvents(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(fs.readFileSync(path.join(srcDir, '..', 'assets', 'icon.png')));
    }
    if (req.method === 'POST' && p === '/api/login') return handleLogin(req, res);
    if (req.method === 'GET' && STATIC_FILES[p] && p.startsWith('/login')) {
      const [dir, file, type] = STATIC_FILES[p];
      return send(res, 200, readStatic(dir, file), type);
    }

    if (!isAuthed(req)) {
      if (p.startsWith('/api/')) return send(res, 401, { ok: false, error: 'Not logged in' });
      return send(res, 302, '', 'text/plain', { Location: '/login' });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      sessions.delete(parseCookies(req.headers.cookie)[COOKIE]);
      return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (req.method === 'POST' && p === '/api/invoke') return handleInvoke(req, res);
    if (req.method === 'GET' && p === '/api/events') return handleEvents(req, res);

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = readStatic('renderer', 'index.html').replace('<script src="app.js"></script>', '<script src="web-shim.js"></script>\n  <script src="app.js"></script>');
      return send(res, 200, html, 'text/html');
    }
    if (req.method === 'GET' && STATIC_FILES[p]) {
      const [dir, file, type] = STATIC_FILES[p];
      return send(res, 200, readStatic(dir, file), type);
    }
    return send(res, 404, { ok: false, error: 'Not found' });
  }

  return {
    start(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        if (server) return resolve(server.address().port);
        const s = http.createServer((req, res) => {
          route(req, res).catch((err) => {
            if (!res.headersSent) send(res, err.status || 500, { ok: false, error: err.status ? err.message : 'Server error' });
          });
        });
        s.once('error', (err) => reject(err.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use`) : err));
        s.listen(port, host, () => {
          server = s;
          keepAlive = setInterval(() => sseClients.forEach((c) => c.write(': ping\n\n')), 25000);
          if (keepAlive.unref) keepAlive.unref();
          resolve(s.address().port);
        });
      });
    },

    stop() {
      return new Promise((resolve) => {
        clearInterval(keepAlive);
        sseClients.forEach((c) => c.end());
        sseClients.clear();
        if (!server) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
        server = null;
      });
    },

    broadcast(event, payload) {
      const msg = `event: ${event}\ndata: ${JSON.stringify(payload === undefined ? null : payload)}\n\n`;
      sseClients.forEach((c) => c.write(msg));
    },

    resetSessions() {
      sessions.clear();
    },

    get running() {
      return Boolean(server);
    },
  };
}

module.exports = { createWebServer, hashPassword, verifyPassword, lanAddresses, MIN_PASSWORD };
