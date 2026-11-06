'use strict';

/**
 * "Start with Windows" handling.
 *
 * Pitfalls this avoids:
 * - The portable exe extracts itself to a temp folder, so process.execPath points to a path
 *   that is gone after a reboot. electron-builder exposes the real exe in PORTABLE_EXECUTABLE_FILE.
 * - In dev (npm start) process.execPath is electron.exe without the app path, which would
 *   launch an empty Electron window at login, so we don't register anything there.
 * - The registry entry is re-synced on every start, so a moved or updated install keeps working.
 */

const LOGIN_ARGS = ['--hidden'];

function createLoginItem({ app, env = process.env }) {
  const supported = app.isPackaged;
  const exePath = env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const options = () => ({ path: exePath, args: LOGIN_ARGS });

  function apply(enabled) {
    if (!supported) return status();
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), ...options() });
    return status();
  }

  function status() {
    if (!supported) {
      return { supported: false, enabled: false, blocked: false, message: 'Only works in the installed app, not with npm start' };
    }
    const s = app.getLoginItemSettings(options());
    const enabled = Boolean(s.openAtLogin);
    // On Windows this is false when the entry is disabled in Task Manager > Startup apps
    const willLaunch = typeof s.executableWillLaunchAtLogin === 'boolean' ? s.executableWillLaunchAtLogin : enabled;
    return {
      supported: true,
      enabled,
      blocked: enabled && !willLaunch,
      path: exePath,
      message: enabled && !willLaunch ? 'Disabled by Windows: turn Hue Desk on in Task Manager > Startup apps' : '',
    };
  }

  return { apply, status, args: LOGIN_ARGS };
}

module.exports = { createLoginItem };
