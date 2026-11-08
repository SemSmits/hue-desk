'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { createWebServer, hashPassword, verifyPassword, lanAddresses } = require('../src/webserver');

const SRC = path.join(__dirname, '..', 'src');

async function setup({ now } = {}) {
  let clock = Date.now();
  const calls = [];
  const password = hashPassword('lampjes123');
  const server = createWebServer({
    getPassword: () => password,
    handlers: {
      'hue:snapshot': async () => ({ groups: [], lights: [] }),
      'hue:action': async (a) => { calls.push(a); return { title: 'Bedroom', value: 'On' }; },
      'web:configure': async () => { calls.push('web:configure'); },
      'config:get': async () => { throw Object.assign(new Error('boom'), { type: 7 }); },
    },
    allowedChannels: new Set(['hue:snapshot', 'hue:action', 'config:get']),
    srcDir: SRC,
    now: now || (() => clock),
  });
  const port = await server.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  return { server, base, calls, advance: (ms) => { clock += ms; } };
}

function req(base, p, { method = 'GET', body, cookie, headers = {} } = {}) {
  return fetch(base + p, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function login(base, password = 'lampjes123') {
  const res = await req(base, '/api/login', { method: 'POST', body: { password } });
  const setCookie = res.headers.get('set-cookie');
  return { res, cookie: setCookie && setCookie.split(';')[0] };
}

const invoke = (base, cookie, channel, ...args) =>
  req(base, '/api/invoke', { method: 'POST', cookie, headers: { 'X-Hue-Desk': '1' }, body: { channel, args } });

test('password hashing', () => {
  const stored = hashPassword('secret12');
  assert.ok(verifyPassword('secret12', stored));
  assert.ok(!verifyPassword('secret13', stored));
  assert.ok(!verifyPassword('secret12', null));
  assert.notEqual(hashPassword('secret12').hash, stored.hash, 'salted');
  assert.throws(() => hashPassword('123'), /at least 6/);
});

test('lanAddresses returns external IPv4 only', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
  };
  assert.deepEqual(lanAddresses(ifaces), ['192.168.1.20']);
});

test('everything except the login page requires a session', async () => {
  const { server, base } = await setup();
  try {
    assert.equal((await req(base, '/')).status, 302);
    assert.equal((await req(base, '/')).headers.get('location'), '/login');
    assert.equal((await req(base, '/app.js')).status, 302);
    assert.equal((await invoke(base, null, 'hue:snapshot')).status, 401);
    const loginPage = await req(base, '/login');
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /Password/);
    assert.equal((await req(base, '/login.js')).status, 200);
  } finally {
    await server.stop();
  }
});

test('login sets a hardened session cookie and unlocks the app', async () => {
  const { server, base } = await setup();
  try {
    assert.equal((await login(base, 'wrong')).res.status, 401);
    const { res, cookie } = await login(base);
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);

    const index = await req(base, '/', { cookie });
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /web-shim\.js[\s\S]*app\.js/, 'shim loads before app.js');
    assert.equal(index.headers.get('x-frame-options'), 'DENY');
  } finally {
    await server.stop();
  }
});

test('invoke runs whitelisted handlers and passes errors through', async () => {
  const { server, base, calls } = await setup();
  try {
    const { cookie } = await login(base);
    let res = await invoke(base, cookie, 'hue:action', { action: 'toggle' });
    assert.deepEqual(await res.json(), { ok: true, data: { title: 'Bedroom', value: 'On' } });
    assert.deepEqual(calls, [{ action: 'toggle' }]);

    res = await invoke(base, cookie, 'config:get');
    assert.deepEqual(await res.json(), { ok: false, error: 'boom', type: 7 });

    res = await invoke(base, cookie, 'web:configure', { password: 'hacked' });
    assert.equal(res.status, 403, 'web settings are PC-only');
    assert.ok(!calls.includes('web:configure'));
  } finally {
    await server.stop();
  }
});

test('invoke without the custom header is rejected (CSRF)', async () => {
  const { server, base } = await setup();
  try {
    const { cookie } = await login(base);
    const res = await req(base, '/api/invoke', { method: 'POST', cookie, body: { channel: 'hue:action', args: [] } });
    assert.equal(res.status, 403);
  } finally {
    await server.stop();
  }
});

test('repeated wrong passwords lock the IP out', async () => {
  const { server, base, advance } = await setup();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login(base, 'nope')).res.status, 401);
    const locked = await login(base); // correct password, but locked
    assert.equal(locked.res.status, 429);
    advance(31 * 1000);
    assert.equal((await login(base)).res.status, 200);
  } finally {
    await server.stop();
  }
});

test('sessions expire and can be reset', async () => {
  const { server, base, advance } = await setup();
  try {
    const { cookie } = await login(base);
    assert.equal((await invoke(base, cookie, 'hue:snapshot')).status, 200);
    server.resetSessions();
    assert.equal((await invoke(base, cookie, 'hue:snapshot')).status, 401);

    const second = await login(base);
    advance(8 * 24 * 60 * 60 * 1000);
    assert.equal((await invoke(base, second.cookie, 'hue:snapshot')).status, 401);
  } finally {
    await server.stop();
  }
});

test('logout ends the session', async () => {
  const { server, base } = await setup();
  try {
    const { cookie } = await login(base);
    await req(base, '/api/logout', { method: 'POST', cookie });
    assert.equal((await invoke(base, cookie, 'hue:snapshot')).status, 401);
  } finally {
    await server.stop();
  }
});

test('server-sent events reach logged-in browsers', async () => {
  const { server, base } = await setup();
  try {
    const { cookie } = await login(base);
    const received = await new Promise((resolve, reject) => {
      const r = http.get(`${base}/api/events`, { headers: { Cookie: cookie } }, (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          if (buf.includes('connected')) server.broadcast('state-dirty');
          if (buf.includes('event: state-dirty')) {
            r.destroy();
            resolve(buf);
          }
        });
      });
      r.on('error', reject);
    });
    assert.match(received, /event: state-dirty\ndata: null/);
  } finally {
    await server.stop();
  }
});

test('port in use gives a readable error', async () => {
  const a = await setup();
  const port = Number(new URL(a.base).port);
  const b = createWebServer({ getPassword: () => null, handlers: {}, allowedChannels: new Set(), srcDir: SRC });
  try {
    await assert.rejects(b.start(port, '127.0.0.1'), /already in use/);
  } finally {
    await a.server.stop();
  }
});
