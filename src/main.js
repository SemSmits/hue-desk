'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen } = require('electron');
const { HueClient } = require('./hue');
const { Store } = require('./store');
const { hexToXy } = require('./color');
const { createActionRunner, PRESETS, ACTIONS } = require('./actions');
const { buildWakeSchedule, parseAlarms } = require('./alarms');
const { createUpdater } = require('./updater');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png');

let store;
let client = null;
let mainWindow = null;
let osdWindow = null;
let osdTimer = null;
let tray = null;
let quitting = false;
let hotkeysPaused = false;
let snapshotCache = { at: 0, data: null };
let updater = null;

// ---------- Hue client & state ----------

function connectFromConfig() {
  const { bridge } = store.get();
  client = bridge ? new HueClient(bridge.ip, bridge.username) : null;
  snapshotCache = { at: 0, data: null };
}

async function getSnapshot(force = false) {
  if (!client) return { lights: [], groups: [] };
  if (!force && snapshotCache.data && Date.now() - snapshotCache.at < 2500) return snapshotCache.data;
  const data = await client.snapshot();
  snapshotCache = { at: Date.now(), data };
  rebuildTrayMenu();
  return data;
}

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

const runner = createActionRunner({
  getClient: () => client,
  getDefaultGroup: () => store.get().defaultGroup,
  getSnapshot,
  onDone: (result) => {
    snapshotCache.at = 0;
    notifyRenderer('state-dirty');
    if (result) showOsd(result);
  },
});

async function runAction(action) {
  try {
    return await runner.run(action);
  } catch (err) {
    showOsd({ title: 'Hue Desk', value: err.message, error: true });
    throw err;
  }
}

/** Translates UI state ({ color: '#hex', ... }) into Hue API state. */
function toHueState(state) {
  const out = { ...state };
  if (out.color) {
    out.xy = hexToXy(out.color);
    out.effect = 'none';
    delete out.color;
  }
  return out;
}

// ---------- Windows ----------

function createMainWindow(show = true) {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Hue Desk',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => show && mainWindow.show());
  mainWindow.on('close', (e) => {
    if (!quitting && store.get().closeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createOsdWindow() {
  osdWindow = new BrowserWindow({
    width: 300,
    height: 84,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  osdWindow.setIgnoreMouseEvents(true);
  osdWindow.setAlwaysOnTop(true, 'screen-saver');
  osdWindow.loadFile(path.join(__dirname, 'osd', 'osd.html'));
}

function showOsd(payload) {
  if (!store.get().osd) return;
  if (!osdWindow || osdWindow.isDestroyed()) createOsdWindow();
  // Don't show the OSD when the main window is focused, the UI already reflects the change
  if (mainWindow && mainWindow.isFocused()) return;

  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [w, h] = osdWindow.getSize();
  osdWindow.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height - h - 80));
  osdWindow.webContents.send('osd', payload);
  osdWindow.showInactive();
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => osdWindow && !osdWindow.isDestroyed() && osdWindow.hide(), 1600);
}

// ---------- Tray ----------

function createTray() {
  const image = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Hue Desk');
  tray.on('click', showMainWindow);
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const config = store.get();
  const snap = snapshotCache.data || { groups: [] };
  const fire = (action) => () => runAction(action).catch(() => {});
  const room = snap.groups.find((g) => g.id === config.defaultGroup);

  const menu = Menu.buildFromTemplate([
    { label: 'Open Hue Desk', click: showMainWindow },
    ...(updater && updater.getStatus().state === 'ready'
      ? [{ label: `Restart to update (v${updater.getStatus().version})`, click: () => updater.installNow() }]
      : []),
    { type: 'separator' },
    { label: room ? `Toggle ${room.name}` : 'Toggle lights', click: fire({ action: 'toggle' }), enabled: Boolean(client) },
    { label: 'All lights off', click: fire({ action: 'allOff' }), enabled: Boolean(client) },
    {
      label: 'Scenes',
      enabled: Boolean(room && room.scenes.length),
      submenu: room && room.scenes.length
        ? room.scenes.slice(0, 25).map((s) => ({ label: s.name, click: fire({ action: 'scene', sceneId: s.id }) }))
        : [{ label: 'None', enabled: false }],
    },
    {
      label: 'Presets',
      enabled: Boolean(client),
      submenu: Object.entries(PRESETS).map(([key, p]) => ({ label: p.label, click: fire({ action: 'preset', preset: key }) })),
    },
    {
      label: 'Sleep timer',
      enabled: Boolean(client),
      submenu: [
        ...[5, 15, 30, 60].map((m) => ({ label: `${m} minutes`, click: fire({ action: 'sleep', minutes: m }) })),
        { type: 'separator' },
        { label: 'Cancel', click: fire({ action: 'cancelSleep' }) },
      ],
    },
    { type: 'separator' },
    {
      label: 'Pause hotkeys',
      type: 'checkbox',
      checked: hotkeysPaused,
      click: (item) => {
        hotkeysPaused = item.checked;
        applyHotkeys();
      },
    },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---------- Hotkeys ----------

function applyHotkeys() {
  globalShortcut.unregisterAll();
  const failed = [];
  if (hotkeysPaused) return { failed };
  for (const hk of store.get().hotkeys) {
    if (!hk.accelerator) continue;
    try {
      const ok = globalShortcut.register(hk.accelerator, () => runAction(hk).catch(() => {}));
      if (!ok) failed.push(hk.accelerator);
    } catch {
      failed.push(hk.accelerator);
    }
  }
  return { failed };
}

// ---------- IPC ----------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message, type: err.type };
    }
  });
}

function registerIpc() {
  handle('config:get', () => store.get());
  handle('meta:get', () => ({ version: app.getVersion(), actions: ACTIONS, presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, p.label])) }));

  handle('config:set', (patch) => {
    const allowed = ['defaultGroup', 'osd', 'launchAtLogin', 'startHidden', 'closeToTray', 'autoUpdate'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    const next = store.set(clean);
    if ('launchAtLogin' in clean) {
      app.setLoginItemSettings({ openAtLogin: Boolean(clean.launchAtLogin), args: ['--hidden'] });
    }
    if ('autoUpdate' in clean) {
      if (clean.autoUpdate) updater.start();
      else updater.stop();
    }
    rebuildTrayMenu();
    return next;
  });

  handle('update:status', () => updater.getStatus());
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.installNow());

  handle('bridge:discover', () => HueClient.discover());
  handle('bridge:pair', async (ip) => {
    const username = await HueClient.pair(ip);
    store.set({ bridge: { ip, username } });
    connectFromConfig();
    rebuildTrayMenu();
    return { ip };
  });
  handle('bridge:forget', () => {
    store.set({ bridge: null });
    connectFromConfig();
    rebuildTrayMenu();
    return true;
  });

  handle('hue:snapshot', async () => ({ ...(await getSnapshot(true)), sleepTimers: runner.getSleepTimers() }));
  handle('hue:setGroup', async (id, state) => {
    await client.setGroup(id, toHueState(state));
    snapshotCache.at = 0;
    return true;
  });
  handle('hue:setLight', async (id, state) => {
    await client.setLight(id, toHueState(state));
    snapshotCache.at = 0;
    return true;
  });
  handle('hue:action', (action) => runAction(action));

  handle('alarms:list', async () => parseAlarms(await client.getSchedules()));
  handle('alarms:create', async (alarm) => {
    const schedule = buildWakeSchedule({ ...alarm, username: store.get().bridge.username });
    return client.createSchedule(schedule);
  });
  handle('alarms:toggle', (id, enabled) => client.updateSchedule(id, { status: enabled ? 'enabled' : 'disabled' }));
  handle('alarms:delete', (id) => client.deleteSchedule(id));

  handle('hotkeys:set', (hotkeys) => {
    store.set({ hotkeys });
    return applyHotkeys();
  });
  handle('hotkeys:suspend', (suspend) => {
    // Used while recording a new shortcut so existing ones don't fire
    if (suspend) globalShortcut.unregisterAll();
    else applyHotkeys();
    return true;
  });
}

// ---------- App lifecycle ----------

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'config.json'));
  connectFromConfig();
  updater = createUpdater({
    app,
    onStatus: (status) => {
      notifyRenderer('update-status', status);
      rebuildTrayMenu();
      if (status.state === 'ready') {
        showOsd({ title: 'Hue Desk', value: `Update v${status.version} ready, restart to install` });
      }
    },
    beforeInstall: () => { quitting = true; },
  });
  registerIpc();

  const startHidden = process.argv.includes('--hidden') || store.get().startHidden;
  createMainWindow(!startHidden);
  createOsdWindow();
  createTray();
  applyHotkeys();
  getSnapshot().catch(() => {});
  if (store.get().autoUpdate) updater.start();
});

app.on('second-instance', showMainWindow);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  // Keep running in the tray
});
