'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_HOTKEYS = [
  { accelerator: 'CommandOrControl+Alt+L', action: 'toggle' },
  { accelerator: 'CommandOrControl+Alt+Up', action: 'brightnessUp' },
  { accelerator: 'CommandOrControl+Alt+Down', action: 'brightnessDown' },
  { accelerator: 'CommandOrControl+Alt+Right', action: 'nextScene' },
  { accelerator: 'CommandOrControl+Alt+Left', action: 'prevScene' },
  { accelerator: 'CommandOrControl+Alt+O', action: 'allOff' },
  { accelerator: 'CommandOrControl+Alt+N', action: 'preset', preset: 'nightlight' },
  { accelerator: 'CommandOrControl+Alt+F', action: 'preset', preset: 'concentrate' },
  { accelerator: 'CommandOrControl+Alt+P', action: 'colorloop' },
  { accelerator: 'CommandOrControl+Alt+S', action: 'sleep', minutes: 30 },
];

const DEFAULTS = {
  bridge: null, // { ip, username }
  defaultGroup: '0',
  hotkeys: DEFAULT_HOTKEYS,
  osd: true,
  launchAtLogin: false,
  startHidden: false,
  closeToTray: true,
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw };
    } catch {
      // First run or corrupt file: keep defaults
    }
  }

  get() {
    return JSON.parse(JSON.stringify(this.data));
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}

module.exports = { Store, DEFAULTS, DEFAULT_HOTKEYS };
