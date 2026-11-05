'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = [
  'config:get', 'config:set', 'meta:get',
  'bridge:discover', 'bridge:pair', 'bridge:forget',
  'hue:snapshot', 'hue:setGroup', 'hue:setLight', 'hue:action',
  'alarms:list', 'alarms:create', 'alarms:toggle', 'alarms:delete',
  'hotkeys:set', 'hotkeys:suspend',
  'update:status', 'update:check', 'update:install',
  'manage:renameLight', 'manage:renameGroup', 'manage:createGroup', 'manage:deleteGroup',
  'manage:setGroupLights', 'manage:moveLight', 'manage:saveScene', 'manage:deleteScene', 'manage:identify',
];

contextBridge.exposeInMainWorld('hue', {
  invoke: async (channel, ...args) => {
    if (!CHANNELS.includes(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
    const res = await ipcRenderer.invoke(channel, ...args);
    if (!res.ok) {
      const err = new Error(res.error);
      err.type = res.type;
      throw err;
    }
    return res.data;
  },
  on: (channel, fn) => {
    if (!['state-dirty', 'osd', 'update-status'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
