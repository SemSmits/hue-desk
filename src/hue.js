'use strict';

/**
 * Minimal Philips Hue client for the local bridge API (v1 / CLIP v1).
 * Uses the global fetch available in Node 18+ and Electron's main process.
 */

const DISCOVERY_URL = 'https://discovery.meethue.com';

class HueError extends Error {
  constructor(message, type) {
    super(message);
    this.name = 'HueError';
    this.type = type;
  }
}

async function fetchJson(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new HueError(`HTTP ${res.status} from ${url}`, 'http');
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new HueError(`Request to ${url} timed out`, 'timeout');
    if (err instanceof HueError) throw err;
    throw new HueError(`Could not reach ${url}: ${err.message}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** The v1 API returns errors as [{ error: { type, description } }] with HTTP 200. */
function unwrap(result) {
  if (Array.isArray(result)) {
    const failed = result.find((r) => r && r.error);
    if (failed) throw new HueError(failed.error.description, failed.error.type);
  }
  return result;
}

function lightCapabilities(light) {
  const control = (light.capabilities && light.capabilities.control) || {};
  const state = light.state || {};
  return {
    hasColor: Boolean(control.colorgamut) || Array.isArray(state.xy),
    hasCt: Boolean(control.ct) || typeof state.ct === 'number',
  };
}

/**
 * Turns raw bridge responses into a compact model for the UI and action runner.
 */
function buildModel({ lights = {}, groups = {}, group0 = null, scenes = {} }) {
  const lightList = Object.entries(lights).map(([id, l]) => ({
    id,
    name: l.name,
    type: l.type,
    on: Boolean(l.state && l.state.on),
    bri: (l.state && l.state.bri) || 0,
    ct: l.state && l.state.ct,
    reachable: l.state ? l.state.reachable !== false : false,
    ...lightCapabilities(l),
  }));
  const lightById = new Map(lightList.map((l) => [l.id, l]));
  for (const [gid, g] of Object.entries(groups)) {
    if (g.type !== 'Room') continue;
    for (const lid of g.lights || []) {
      const light = lightById.get(lid);
      if (light) light.roomId = gid;
    }
  }

  const sceneList = Object.entries(scenes)
    .filter(([, s]) => !s.recycle)
    .map(([id, s]) => ({ id, name: s.name, group: s.group || null, lights: s.lights || [] }));

  const toGroup = (id, g) => {
    const members = (g.lights || []).map((lid) => lightById.get(lid)).filter(Boolean);
    return {
      id,
      name: id === '0' ? 'All lights' : g.name,
      type: id === '0' ? 'All' : g.type,
      class: g.class || null,
      lights: g.lights || [],
      anyOn: Boolean(g.state && g.state.any_on),
      allOn: Boolean(g.state && g.state.all_on),
      bri: (g.action && g.action.bri) || 0,
      ct: g.action && g.action.ct,
      effect: (g.action && g.action.effect) || 'none',
      hasColor: members.some((l) => l.hasColor),
      hasCt: members.some((l) => l.hasCt),
      scenes: sceneList
        .filter((s) => s.group === id)
        .map(({ id: sid, name }) => ({ id: sid, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  };

  const groupList = Object.entries(groups)
    .filter(([, g]) => g.type === 'Room' || g.type === 'Zone')
    .map(([id, g]) => toGroup(id, g))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'Room' ? -1 : 1));

  if (group0) {
    const all = toGroup('0', { ...group0, lights: lightList.map((l) => l.id) });
    all.scenes = sceneList
      .filter((s) => s.group)
      .map(({ id, name, group }) => ({ id, name, group }))
      .sort((a, b) => a.name.localeCompare(b.name));
    groupList.unshift(all);
  }

  return { lights: lightList, groups: groupList };
}

class HueClient {
  constructor(ip, username) {
    this.ip = ip;
    this.username = username;
  }

  get base() {
    return `http://${this.ip}/api/${this.username}`;
  }

  static async discover() {
    const list = await fetchJson(DISCOVERY_URL, {}, 8000);
    return (list || []).map((b) => ({ id: b.id, ip: b.internalipaddress }));
  }

  /** Throws HueError with type 101 when the link button has not been pressed. */
  static async pair(ip, deviceType = 'hue-desk#pc') {
    const res = unwrap(
      await fetchJson(`http://${ip}/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devicetype: deviceType }),
      })
    );
    return res[0].success.username;
  }

  async request(method, path, body) {
    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) options.body = JSON.stringify(body);
    return unwrap(await fetchJson(this.base + path, options));
  }

  async snapshot() {
    const [lights, groups, group0, scenes] = await Promise.all([
      this.request('GET', '/lights'),
      this.request('GET', '/groups'),
      this.request('GET', '/groups/0'),
      this.request('GET', '/scenes'),
    ]);
    return buildModel({ lights, groups, group0, scenes });
  }

  getGroup(id) {
    return this.request('GET', `/groups/${id}`);
  }

  setGroup(id, state) {
    return this.request('PUT', `/groups/${id}/action`, state);
  }

  setLight(id, state) {
    return this.request('PUT', `/lights/${id}/state`, state);
  }

  recallScene(groupId, sceneId) {
    return this.setGroup(groupId, { scene: sceneId });
  }

  getSchedules() {
    return this.request('GET', '/schedules');
  }

  createSchedule(schedule) {
    return this.request('POST', '/schedules', schedule);
  }

  updateSchedule(id, patch) {
    return this.request('PUT', `/schedules/${id}`, patch);
  }

  deleteSchedule(id) {
    return this.request('DELETE', `/schedules/${id}`);
  }

  updateLight(id, attrs) {
    return this.request('PUT', `/lights/${id}`, attrs);
  }

  updateGroup(id, attrs) {
    return this.request('PUT', `/groups/${id}`, attrs);
  }

  createGroup(group) {
    return this.request('POST', '/groups', group);
  }

  deleteGroup(id) {
    return this.request('DELETE', `/groups/${id}`);
  }

  createScene(scene) {
    return this.request('POST', '/scenes', scene);
  }

  deleteScene(id) {
    return this.request('DELETE', `/scenes/${id}`);
  }
}

module.exports = { HueClient, HueError, buildModel, unwrap };
