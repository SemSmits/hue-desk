'use strict';

/**
 * Auto-updates via electron-updater + GitHub Releases.
 * Only works in the installed (NSIS) build: dev mode and the portable exe can't self-update.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

function createUpdater({ app, onStatus = () => {}, beforeInstall = () => {}, autoUpdaterImpl = null }) {
  let autoUpdater = autoUpdaterImpl; // injectable for tests
  let status = { state: 'idle', currentVersion: app.getVersion() };
  let timer = null;

  const set = (patch) => {
    status = { currentVersion: app.getVersion(), ...patch };
    onStatus(status);
  };

  if (autoUpdater) {
    // Injected (tests)
  } else if (!app.isPackaged) {
    status = { ...status, state: 'unsupported', message: 'Updates only work in the installed app' };
  } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
    status = { ...status, state: 'unsupported', message: 'Portable version: download new releases manually' };
  } else {
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch {
      status = { ...status, state: 'unsupported', message: 'electron-updater is not installed' };
    }
  }

  if (autoUpdater) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => set({ state: 'upToDate', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => set({ ...status, state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => set({ state: 'error', message: err ? err.message : 'Update failed' }));
  }

  async function check() {
    if (!autoUpdater) return status;
    if (status.state === 'downloading' || status.state === 'ready') return status;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      set({ state: 'error', message: err.message });
    }
    return status;
  }

  function installNow() {
    if (!autoUpdater || status.state !== 'ready') return false;
    beforeInstall();
    autoUpdater.quitAndInstall(true, true); // silent install, relaunch afterwards
    return true;
  }

  function start() {
    if (!autoUpdater || timer) return;
    setTimeout(check, 10 * 1000);
    timer = setInterval(check, CHECK_INTERVAL_MS);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { check, installNow, start, stop, getStatus: () => status, supported: Boolean(autoUpdater) };
}

module.exports = { createUpdater };
