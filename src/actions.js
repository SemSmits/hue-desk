'use strict';

/**
 * Action runner shared by global hotkeys, the tray menu and the UI.
 * Each action resolves to { title, value } which is shown in the OSD.
 */

const PRESETS = {
  energize: { label: 'Energize', state: { on: true, bri: 254, ct: 156 } },
  concentrate: { label: 'Concentrate', state: { on: true, bri: 254, ct: 233 } },
  read: { label: 'Read', state: { on: true, bri: 254, ct: 346 } },
  relax: { label: 'Relax', state: { on: true, bri: 144, ct: 447 } },
  nightlight: { label: 'Nightlight', state: { on: true, bri: 1, ct: 500 } },
};

const ACTIONS = {
  toggle: 'Toggle on/off',
  brightnessUp: 'Brightness up',
  brightnessDown: 'Brightness down',
  nextScene: 'Next scene',
  prevScene: 'Previous scene',
  scene: 'Activate scene',
  preset: 'Light preset',
  allOff: 'All lights off',
  colorloop: 'Party mode (color loop)',
  sleep: 'Sleep timer (fade out)',
  blink: 'Blink (find room)',
};

const BRI_STEP = 25; // ~10%

function toPercent(bri) {
  return Math.round((Math.max(1, bri) / 254) * 100);
}

function createActionRunner({ getClient, getDefaultGroup, getSnapshot, onDone = () => {} }) {
  const sceneIndex = new Map();
  const sleepTimers = new Map(); // groupId -> { endsAt, timeout, restoreBri }

  async function groupName(groupId) {
    const snap = await getSnapshot();
    const g = snap.groups.find((x) => x.id === groupId);
    return g ? g.name : `Group ${groupId}`;
  }

  async function readGroup(client, groupId) {
    const g = await client.getGroup(groupId);
    return { anyOn: Boolean(g.state && g.state.any_on), bri: (g.action && g.action.bri) || 0, effect: (g.action && g.action.effect) || 'none' };
  }

  async function cycleScene(client, groupId, direction) {
    const snap = await getSnapshot(true);
    const group = snap.groups.find((g) => g.id === groupId);
    const scenes = group ? group.scenes : [];
    if (scenes.length === 0) return { title: await groupName(groupId), value: 'No scenes' };
    const current = sceneIndex.has(groupId) ? sceneIndex.get(groupId) : direction > 0 ? -1 : 0;
    const next = (current + direction + scenes.length) % scenes.length;
    sceneIndex.set(groupId, next);
    const scene = scenes[next];
    await client.recallScene(scene.group || groupId, scene.id);
    return { title: group.name, value: scene.name };
  }

  function cancelSleep(groupId) {
    const timer = sleepTimers.get(groupId);
    if (!timer) return null;
    clearTimeout(timer.timeout);
    sleepTimers.delete(groupId);
    return timer;
  }

  async function startSleep(client, groupId, minutes) {
    cancelSleep(groupId);
    const state = await readGroup(client, groupId);
    if (!state.anyOn) return { title: await groupName(groupId), value: 'Already off' };
    // transitiontime is in 100ms steps, max 65535 (~109 min)
    const ds = Math.min(65535, Math.round(minutes * 600));
    await client.setGroup(groupId, { on: false, transitiontime: ds });
    const timeout = setTimeout(() => {
      sleepTimers.delete(groupId);
      onDone();
    }, ds * 100);
    sleepTimers.set(groupId, { endsAt: Date.now() + ds * 100, timeout, restoreBri: state.bri || 254 });
    return { title: await groupName(groupId), value: `Sleep in ${minutes} min` };
  }

  async function run(action) {
    const client = getClient();
    if (!client) throw new Error('No bridge paired yet');
    const groupId = action.groupId || getDefaultGroup() || '0';
    let result;

    switch (action.action) {
      case 'toggle': {
        const { anyOn } = await readGroup(client, groupId);
        if (anyOn) cancelSleep(groupId);
        await client.setGroup(groupId, { on: !anyOn });
        result = { title: await groupName(groupId), value: anyOn ? 'Off' : 'On' };
        break;
      }
      case 'brightnessUp':
      case 'brightnessDown': {
        const up = action.action === 'brightnessUp';
        const { anyOn, bri } = await readGroup(client, groupId);
        cancelSleep(groupId);
        if (!anyOn && !up) {
          result = { title: await groupName(groupId), value: 'Off' };
          break;
        }
        const target = anyOn ? Math.max(1, Math.min(254, bri + (up ? BRI_STEP : -BRI_STEP))) : BRI_STEP;
        await client.setGroup(groupId, { on: true, bri: target, transitiontime: 2 });
        result = { title: await groupName(groupId), value: `${toPercent(target)}%`, percent: toPercent(target) };
        break;
      }
      case 'nextScene':
        result = await cycleScene(client, groupId, 1);
        break;
      case 'prevScene':
        result = await cycleScene(client, groupId, -1);
        break;
      case 'scene': {
        if (!action.sceneId) throw new Error('No scene selected for this hotkey');
        const snap = await getSnapshot();
        const group = snap.groups.find((g) => g.id === groupId);
        const scene = group && group.scenes.find((s) => s.id === action.sceneId);
        await client.recallScene((scene && scene.group) || groupId, action.sceneId);
        result = { title: group ? group.name : 'Scene', value: scene ? scene.name : 'Scene activated' };
        break;
      }
      case 'preset': {
        const preset = PRESETS[action.preset];
        if (!preset) throw new Error(`Unknown preset: ${action.preset}`);
        cancelSleep(groupId);
        await client.setGroup(groupId, { ...preset.state, effect: 'none', transitiontime: 4 });
        result = { title: await groupName(groupId), value: preset.label };
        break;
      }
      case 'allOff':
        for (const id of sleepTimers.keys()) cancelSleep(id);
        await client.setGroup('0', { on: false });
        result = { title: 'All lights', value: 'Off' };
        break;
      case 'colorloop': {
        const { effect } = await readGroup(client, groupId);
        const enable = effect !== 'colorloop';
        await client.setGroup(groupId, enable ? { on: true, effect: 'colorloop' } : { effect: 'none' });
        result = { title: await groupName(groupId), value: enable ? 'Party mode on' : 'Party mode off' };
        break;
      }
      case 'sleep':
        result = await startSleep(client, groupId, Number(action.minutes) || 30);
        break;
      case 'cancelSleep': {
        const timer = cancelSleep(groupId);
        if (timer) await client.setGroup(groupId, { on: true, bri: timer.restoreBri, transitiontime: 4 });
        result = { title: await groupName(groupId), value: timer ? 'Sleep timer cancelled' : 'No sleep timer' };
        break;
      }
      case 'blink':
        await client.setGroup(groupId, { alert: 'lselect' });
        setTimeout(() => client.setGroup(groupId, { alert: 'none' }).catch(() => {}), 4000);
        result = { title: await groupName(groupId), value: 'Blinking' };
        break;
      default:
        throw new Error(`Unknown action: ${action.action}`);
    }

    onDone(result);
    return result;
  }

  function getSleepTimers() {
    const out = {};
    for (const [id, t] of sleepTimers) out[id] = t.endsAt;
    return out;
  }

  return { run, getSleepTimers };
}

module.exports = { createActionRunner, PRESETS, ACTIONS, toPercent };
