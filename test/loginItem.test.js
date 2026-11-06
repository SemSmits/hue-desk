'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginItem } = require('../src/loginItem');

function fakeApp({ isPackaged = true, willLaunch = true } = {}) {
  const calls = [];
  let registered = null;
  return {
    calls,
    isPackaged,
    setLoginItemSettings(opts) { calls.push(opts); registered = opts.openAtLogin ? opts : null; },
    getLoginItemSettings(opts) {
      const match = registered && registered.path === opts.path && registered.args.join() === opts.args.join();
      return { openAtLogin: Boolean(match), executableWillLaunchAtLogin: Boolean(match) && willLaunch };
    },
  };
}

test('does nothing in dev mode', () => {
  const app = fakeApp({ isPackaged: false });
  const st = createLoginItem({ app, env: {} }).apply(true);
  assert.equal(app.calls.length, 0);
  assert.equal(st.supported, false);
});

test('registers the installed exe with --hidden', () => {
  const app = fakeApp();
  const st = createLoginItem({ app, env: {} }).apply(true);
  assert.equal(app.calls[0].path, process.execPath);
  assert.deepEqual(app.calls[0].args, ['--hidden']);
  assert.deepEqual([st.enabled, st.blocked], [true, false]);
});

test('portable build registers the real exe, not the temp extraction', () => {
  const app = fakeApp();
  const st = createLoginItem({ app, env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Users\\sem\\HueDesk-Portable.exe' } }).apply(true);
  assert.equal(app.calls[0].path, 'C:\\Users\\sem\\HueDesk-Portable.exe');
  assert.equal(st.path, 'C:\\Users\\sem\\HueDesk-Portable.exe');
});

test('reports when Windows has disabled the startup entry', () => {
  const st = createLoginItem({ app: fakeApp({ willLaunch: false }), env: {} }).apply(true);
  assert.equal(st.blocked, true);
  assert.match(st.message, /Task Manager/);
});

test('turning it off unregisters', () => {
  const app = fakeApp();
  const li = createLoginItem({ app, env: {} });
  li.apply(true);
  const st = li.apply(false);
  assert.equal(app.calls[1].openAtLogin, false);
  assert.equal(st.enabled, false);
});
