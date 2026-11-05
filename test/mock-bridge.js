'use strict';

/**
 * Tiny fake Hue bridge (v1 API) for tests and for running the app without real lights:
 *   node test/mock-bridge.js 8080   -> pair with IP "127.0.0.1:8080"
 */

const http = require('http');

function createState() {
  return {
    linkPressed: false,
    username: 'test-user',
    calls: [],
    lights: {
      1: { name: 'Desk lamp', type: 'Extended color light', state: { on: true, bri: 200, ct: 300, xy: [0.4, 0.4], reachable: true }, capabilities: { control: { colorgamut: [[0.6, 0.3], [0.2, 0.7], [0.1, 0.1]], ct: { min: 153, max: 500 } } } },
      2: { name: 'Ceiling', type: 'Color temperature light', state: { on: false, bri: 100, ct: 400, reachable: true }, capabilities: { control: { ct: { min: 153, max: 454 } } } },
      3: { name: 'Hallway', type: 'Dimmable light', state: { on: false, bri: 50, reachable: false }, capabilities: { control: {} } },
    },
    groups: {
      1: { name: 'Bedroom', type: 'Room', class: 'Bedroom', lights: ['1', '2'], state: { any_on: true, all_on: false }, action: { on: true, bri: 200, ct: 300, effect: 'none' } },
      2: { name: 'Desk', type: 'Zone', lights: ['1'], state: { any_on: true, all_on: true }, action: { on: true, bri: 200, effect: 'none' } },
      3: { name: 'Entertainment', type: 'Entertainment', lights: ['1'], state: {}, action: {} },
    },
    group0: { name: 'Group 0', lights: [], state: { any_on: true, all_on: false }, action: { on: true, bri: 150, effect: 'none' } },
    scenes: {
      s1: { name: 'Bright', type: 'GroupScene', group: '1', lights: ['1', '2'] },
      s2: { name: 'Chill', type: 'GroupScene', group: '1', lights: ['1', '2'] },
      s3: { name: 'Old scene', type: 'LightScene', lights: ['1'] },
      s4: { name: 'Focus', type: 'GroupScene', group: '2', lights: ['1'] },
    },
    schedules: {},
    nextSchedule: 1,
  };
}

function applyAction(target, body) {
  for (const [k, v] of Object.entries(body)) {
    if (k === 'transitiontime' || k === 'scene' || k === 'alert') continue;
    target.action[k] = v;
  }
  if ('on' in body) target.state = { ...target.state, any_on: body.on, all_on: body.on };
}

function startMockBridge(port = 0) {
  const st = createState();

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      st.calls.push({ method: req.method, url: req.url, body });

      if (req.method === 'POST' && req.url === '/api') {
        if (!st.linkPressed) return send([{ error: { type: 101, address: '', description: 'link button not pressed' } }]);
        return send([{ success: { username: st.username } }]);
      }

      const m = /^\/api\/([^/]+)(\/.*)?$/.exec(req.url);
      if (!m) return send([{ error: { type: 4, description: 'method not available' } }]);
      if (m[1] !== st.username) return send([{ error: { type: 1, address: m[2] || '/', description: 'unauthorized user' } }]);
      const p = m[2] || '/';
      let mm;

      if (req.method === 'GET' && p === '/lights') return send(st.lights);
      if (req.method === 'GET' && p === '/groups') return send(st.groups);
      if (req.method === 'GET' && p === '/groups/0') return send(st.group0);
      if (req.method === 'GET' && (mm = /^\/groups\/(\w+)$/.exec(p))) return send(st.groups[mm[1]]);
      if (req.method === 'GET' && p === '/scenes') return send(st.scenes);
      if (req.method === 'PUT' && (mm = /^\/groups\/(\w+)\/action$/.exec(p))) {
        applyAction(mm[1] === '0' ? st.group0 : st.groups[mm[1]], body);
        return send(Object.keys(body).map((k) => ({ success: { [`/groups/${mm[1]}/action/${k}`]: body[k] } })));
      }
      if (req.method === 'PUT' && (mm = /^\/lights\/(\w+)\/state$/.exec(p))) {
        Object.assign(st.lights[mm[1]].state, body);
        return send([{ success: {} }]);
      }
      if (req.method === 'GET' && p === '/schedules') return send(st.schedules);
      if (req.method === 'POST' && p === '/schedules') {
        const id = String(st.nextSchedule++);
        st.schedules[id] = body;
        return send([{ success: { id } }]);
      }
      if (req.method === 'PUT' && (mm = /^\/schedules\/(\w+)$/.exec(p))) {
        Object.assign(st.schedules[mm[1]], body);
        return send([{ success: {} }]);
      }
      if (req.method === 'DELETE' && (mm = /^\/schedules\/(\w+)$/.exec(p))) {
        delete st.schedules[mm[1]];
        return send([{ success: `/schedules/${mm[1]} deleted` }]);
      }
      return send([{ error: { type: 3, description: `resource ${p} not available` } }]);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ state: st, host: `127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

if (require.main === module) {
  startMockBridge(Number(process.argv[2]) || 8080).then(({ host, state }) => {
    state.linkPressed = true;
    console.log(`Mock Hue bridge running at ${host} (link button always pressed)`);
  });
}

module.exports = { startMockBridge };
