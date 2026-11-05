'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater } = require('../src/updater');

const fakeApp = (isPackaged) => ({ isPackaged, getVersion: () => '1.1.0' });

test('updater is disabled in dev and portable builds', () => {
  assert.equal(createUpdater({ app: fakeApp(false) }).getStatus().state, 'unsupported');
  process.env.PORTABLE_EXECUTABLE_DIR = 'C:\\tmp';
  try {
    const u = createUpdater({ app: fakeApp(true) });
    assert.match(u.getStatus().message, /Portable/);
    assert.equal(u.supported, false);
  } finally {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  }
});

test('updater tracks download and installs only when ready', async () => {
  const fake = new EventEmitter();
  let installed = false;
  let prepared = false;
  fake.checkForUpdates = async () => {
    fake.emit('checking-for-update');
    fake.emit('update-available', { version: '1.2.0' });
    fake.emit('download-progress', { percent: 41.7 });
  };
  fake.quitAndInstall = () => { installed = true; };
  const statuses = [];
  const u = createUpdater({ app: fakeApp(true), autoUpdaterImpl: fake, onStatus: (s) => statuses.push(s.state), beforeInstall: () => { prepared = true; } });

  await u.check();
  assert.deepEqual(u.getStatus(), { currentVersion: '1.1.0', state: 'downloading', version: '1.2.0', percent: 42 });
  assert.equal(u.installNow(), false, 'not ready yet');

  fake.emit('update-downloaded', { version: '1.2.0' });
  assert.equal(u.getStatus().state, 'ready');
  assert.equal(u.installNow(), true);
  assert.ok(installed && prepared);
  assert.deepEqual(statuses, ['checking', 'downloading', 'downloading', 'ready']);
});

test('updater reports errors', async () => {
  const fake = new EventEmitter();
  fake.checkForUpdates = async () => { throw new Error('404 Not Found'); };
  const u = createUpdater({ app: fakeApp(true), autoUpdaterImpl: fake });
  await u.check();
  assert.equal(u.getStatus().state, 'error');
  assert.match(u.getStatus().message, /404/);
});
