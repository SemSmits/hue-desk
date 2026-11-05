'use strict';

const api = window.hue;

const S = {
  tab: 'rooms',
  config: null,
  meta: null,
  snap: null,
  error: null,
  pointerDown: false,
  interactingUntil: 0,
  hotkeyDraft: null,
  failedHotkeys: [],
  recording: null,
  alarms: null,
  update: null,
  manageOpen: new Set(),
  confirmDelete: null,
  newGroup: { name: '', type: 'Room', roomClass: 'Other' },
  setup: { bridges: [], ip: '', status: '', pairing: false },
};

const DAYS = [
  ['mon', 'Mo'], ['tue', 'Tu'], ['wed', 'We'], ['thu', 'Th'], ['fri', 'Fr'], ['sat', 'Sa'], ['sun', 'Su'],
];

// ---------- Helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  const late = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value' || k === 'checked') late[k] = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  Object.assign(el, late); // set value/checked after options exist (needed for <select>)
  return el;
}

const throttles = new Map();
function throttled(key, fn, ms = 150) {
  if (!throttles.has(key)) {
    let last = 0;
    let timer = null;
    let pending = null;
    throttles.set(key, (...args) => {
      pending = args;
      const run = () => {
        last = Date.now();
        timer = null;
        fn(...pending);
      };
      const wait = ms - (Date.now() - last);
      if (wait <= 0) run();
      else if (!timer) timer = setTimeout(run, wait);
    });
  }
  return throttles.get(key);
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

async function call(channel, ...args) {
  try {
    return await api.invoke(channel, ...args);
  } catch (err) {
    toast(err.message, true);
    throw err;
  }
}

const pct = (bri) => Math.round((Math.max(1, bri) / 254) * 100);
const kelvin = (mired) => Math.round(1e6 / mired);
const groupName = (id) => (S.snap && S.snap.groups.find((g) => g.id === id) || {}).name || `Group ${id}`;

function switchEl(checked, onChange) {
  return h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }),
    h('span'));
}

function groupOptions(selected, includeDefault = false) {
  const opts = includeDefault ? [h('option', { value: '' }, 'Default room')] : [];
  for (const g of (S.snap && S.snap.groups) || []) opts.push(h('option', { value: g.id }, g.name));
  return h('select', { value: selected == null ? '' : selected }, opts);
}

// ---------- Data ----------

async function loadConfig() {
  S.config = await api.invoke('config:get');
  S.meta = S.meta || (await api.invoke('meta:get'));
}

function isInteracting() {
  return S.pointerDown || Date.now() < S.interactingUntil || S.recording != null;
}

async function refresh(force = false) {
  if (!S.config || !S.config.bridge) return;
  const status = document.getElementById('status');
  try {
    S.snap = await api.invoke('hue:snapshot');
    S.error = null;
    status.className = 'status ok';
    status.textContent = `Bridge ${S.config.bridge.ip}`;
  } catch (err) {
    S.error = err.message;
    status.className = 'status err';
    status.textContent = err.type === 1 ? 'Not authorized, re-pair' : 'Bridge unreachable';
  }
  if (force || (!isInteracting() && (S.tab === 'rooms' || S.tab === 'lights'))) render();
}

// ---------- Setup ----------

function renderSetup() {
  const st = S.setup;
  const discover = async () => {
    st.status = 'Searching...';
    render();
    try {
      st.bridges = await api.invoke('bridge:discover');
      st.status = st.bridges.length ? '' : 'No bridges found. Enter the IP manually (Hue app > Settings > Bridges).';
      if (st.bridges.length === 1) st.ip = st.bridges[0].ip;
    } catch (err) {
      st.status = `Discovery failed: ${err.message}`;
    }
    render();
  };

  const pair = async () => {
    if (!st.ip) return toast('Enter the bridge IP first', true);
    st.pairing = true;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      st.status = `Waiting for link button... ${Math.ceil((deadline - Date.now()) / 1000)}s`;
      render();
      try {
        await api.invoke('bridge:pair', st.ip);
        st.pairing = false;
        st.status = '';
        await loadConfig();
        toast('Paired! Lights incoming');
        await refresh(true);
        return;
      } catch (err) {
        if (err.type !== 101) {
          st.status = `Error: ${err.message}`;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (st.pairing) st.status = st.status.startsWith('Error') ? st.status : 'Timed out. Press the button and try again.';
    st.pairing = false;
    render();
  };

  return h('div', { class: 'setup' },
    h('h1', {}, 'Connect your Hue Bridge'),
    h('p', { class: 'sub' }, 'One-time setup. Your PC must be on the same network as the bridge.'),
    h('div', { class: 'step' },
      h('h3', {}, '1. Find your bridge'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: discover }, 'Search network'),
        h('input', { type: 'text', placeholder: '192.168.1.x', value: st.ip, oninput: (e) => { st.ip = e.target.value.trim(); } })),
      st.bridges.length > 0 && h('div', { class: 'chips mt-10' },
        st.bridges.map((b) => h('span', { class: 'chip', onclick: () => { st.ip = b.ip; render(); } }, b.ip)))),
    h('div', { class: 'step' },
      h('h3', {}, '2. Press the link button, then pair'),
      h('p', { class: 'muted' }, 'Press the big round button on top of the bridge and click Pair within 30 seconds.'),
      h('button', { class: 'btn primary', onclick: pair, disabled: st.pairing }, st.pairing ? 'Pairing...' : 'Pair')),
    st.status && h('p', { class: 'muted' }, st.status));
}

// ---------- Rooms ----------

function setGroup(id, state) {
  return call('hue:setGroup', id, state).then(() => setTimeout(() => refresh(), 600)).catch(() => {});
}

function runAction(action) {
  return call('hue:action', action).then((r) => { if (r) toast(`${r.title}: ${r.value}`); refresh(true); }).catch(() => {});
}

function groupCard(g) {
  const sleepAt = S.snap.sleepTimers && S.snap.sleepTimers[g.id];
  const isTarget = (S.config.defaultGroup || '0') === g.id;
  const briLabel = h('span', {}, `${pct(g.bri)}%`);
  const ctLabel = h('span', {}, g.ct ? `${kelvin(g.ct)}K` : '');
  let sleepMinutes = 30;

  return h('div', { class: `card${g.anyOn ? ' on' : ''}` },
    h('div', { class: 'card-head' },
      switchEl(g.anyOn, (on) => setGroup(g.id, { on })),
      h('div', {},
        h('div', { class: 'card-title' }, g.name),
        h('div', { class: 'card-meta' }, `${g.lights.length} light${g.lights.length === 1 ? '' : 's'} · ${g.type}`,
          sleepAt ? h('span', { class: 'sleep-badge' }, ` · sleep in ${Math.max(1, Math.round((sleepAt - Date.now()) / 60000))} min`) : null)),
      h('div', { class: 'spacer' }),
      h('button', {
        class: `btn small${isTarget ? ' active' : ''}`,
        title: 'Hotkeys and tray control this room',
        onclick: async () => { S.config = await call('config:set', { defaultGroup: g.id }); render(); },
      }, isTarget ? 'Hotkey target' : 'Set as target')),

    h('div', {},
      h('div', { class: 'label' }, h('span', {}, 'Brightness'), briLabel),
      h('input', {
        type: 'range', class: 'bri', min: 1, max: 254, value: g.bri || 1,
        oninput: (e) => {
          const bri = Number(e.target.value);
          briLabel.textContent = `${pct(bri)}%`;
          throttled(`bri-${g.id}`, (v) => call('hue:setGroup', g.id, { on: true, bri: v }).catch(() => {}))(bri);
        },
      })),

    g.hasCt && h('div', {},
      h('div', { class: 'label' }, h('span', {}, 'White temperature'), ctLabel),
      h('input', {
        type: 'range', class: 'ct', min: 153, max: 500, value: g.ct || 366,
        oninput: (e) => {
          const ct = Number(e.target.value);
          ctLabel.textContent = `${kelvin(ct)}K`;
          throttled(`ct-${g.id}`, (v) => call('hue:setGroup', g.id, { on: true, ct: v }).catch(() => {}))(ct);
        },
      })),

    h('div', { class: 'row' },
      g.hasColor && h('input', {
        type: 'color', value: '#ffaa55', title: 'Pick a color',
        oninput: (e) => throttled(`color-${g.id}`, (v) => call('hue:setGroup', g.id, { on: true, color: v }).catch(() => {}), 250)(e.target.value),
      }),
      g.hasColor && h('button', { class: `btn small${g.effect === 'colorloop' ? ' active' : ''}`, onclick: () => runAction({ action: 'colorloop', groupId: g.id }) }, 'Party mode'),
      h('button', { class: 'btn small', onclick: () => runAction({ action: 'blink', groupId: g.id }) }, 'Blink'),
      h('div', { class: 'spacer' }),
      sleepAt
        ? h('button', { class: 'btn small', onclick: () => runAction({ action: 'cancelSleep', groupId: g.id }) }, 'Cancel sleep')
        : [
          h('select', { value: '30', onchange: (e) => { sleepMinutes = Number(e.target.value); } },
            [5, 15, 30, 45, 60, 90].map((m) => h('option', { value: String(m) }, `${m} min`))),
          h('button', { class: 'btn small', disabled: !g.anyOn, onclick: () => runAction({ action: 'sleep', groupId: g.id, minutes: sleepMinutes }) }, 'Sleep'),
        ]),

    h('div', {},
      h('div', { class: 'label' }, h('span', {}, 'Presets')),
      h('div', { class: 'chips' },
        Object.entries(S.meta.presets).map(([key, label]) =>
          h('span', { class: 'chip', onclick: () => runAction({ action: 'preset', preset: key, groupId: g.id }) }, label)))),

    g.id !== '0' && g.scenes.length > 0 && h('div', {},
      h('div', { class: 'label' }, h('span', {}, 'Scenes')),
      h('div', { class: 'chips' },
        g.scenes.map((s) => h('span', { class: 'chip', onclick: () => runAction({ action: 'scene', sceneId: s.id, groupId: g.id }) }, s.name)))));
}

function renderRooms() {
  if (!S.snap) return h('p', { class: 'muted' }, S.error || 'Loading...');
  return h('div', {},
    h('h1', {}, 'Rooms'),
    h('p', { class: 'sub' }, `Hotkeys control: ${groupName(S.config.defaultGroup || '0')}`),
    h('div', { class: 'grid' }, S.snap.groups.map(groupCard)));
}

// ---------- Lights ----------

function renderLights() {
  if (!S.snap) return h('p', { class: 'muted' }, S.error || 'Loading...');
  const set = (id, state) => call('hue:setLight', id, state).then(() => setTimeout(() => refresh(), 600)).catch(() => {});
  return h('div', {},
    h('h1', {}, 'Lights'),
    h('p', { class: 'sub' }, 'Control individual bulbs. Greyed out = unreachable (switched off at the wall?).'),
    h('div', { class: 'card' },
      S.snap.lights.map((l) => h('div', { class: `light-row${l.reachable ? '' : ' unreachable'}` },
        h('div', {}, h('div', {}, l.name), h('div', { class: 'card-meta' }, l.type)),
        h('input', {
          type: 'range', class: 'bri', min: 1, max: 254, value: l.bri || 1,
          oninput: (e) => throttled(`lbri-${l.id}`, (v) => call('hue:setLight', l.id, { on: true, bri: v }).catch(() => {}))(Number(e.target.value)),
        }),
        l.hasColor
          ? h('input', { type: 'color', value: '#ffaa55', oninput: (e) => throttled(`lcol-${l.id}`, (v) => call('hue:setLight', l.id, { on: true, color: v }).catch(() => {}), 250)(e.target.value) })
          : h('span'),
        switchEl(l.on, (on) => set(l.id, { on }))))));
}

// ---------- Manage ----------

async function manageCall(channel, ...args) {
  try {
    const res = await call(channel, ...args);
    await refresh(true);
    return res;
  } catch {
    render(); // restore original values in inputs
    return undefined;
  }
}

function nameInput(value, onSave) {
  return h('input', {
    type: 'text', class: 'name-input', value, maxlength: 32, title: 'Click to rename',
    onfocus: (e) => e.target.select(),
    onkeydown: (e) => {
      if (e.key === 'Enter') e.target.blur();
      if (e.key === 'Escape') { e.target.value = value; e.target.blur(); }
    },
    onchange: (e) => {
      const next = e.target.value.trim();
      if (next && next !== value) onSave(next);
      else e.target.value = value;
    },
  });
}

function deleteButton(key, label, onConfirm) {
  const armed = S.confirmDelete === key;
  return h('button', {
    class: `btn small danger${armed ? ' active' : ''}`,
    onclick: () => {
      if (armed) {
        S.confirmDelete = null;
        onConfirm();
      } else {
        S.confirmDelete = key;
        render();
        setTimeout(() => { if (S.confirmDelete === key) { S.confirmDelete = null; render(); } }, 3000);
      }
    },
  }, armed ? 'Sure?' : label);
}

function groupPanel(g) {
  const rooms = new Map(S.snap.groups.filter((x) => x.type === 'Room').map((x) => [x.id, x.name]));
  let sceneName = '';
  const toggleLight = (lightId) => {
    const next = g.lights.includes(lightId) ? g.lights.filter((l) => l !== lightId) : [...g.lights, lightId];
    manageCall('manage:setGroupLights', g.id, next);
  };

  return h('div', { class: 'panel' },
    h('div', { class: 'label' }, h('span', {}, g.type === 'Room'
      ? 'Lights (a light can only be in one room, adding it here moves it)'
      : 'Lights (zones can share lights with rooms)')),
    h('div', { class: 'chips' }, S.snap.lights.map((l) => {
      const inGroup = g.lights.includes(l.id);
      const elsewhere = g.type === 'Room' && !inGroup && l.roomId ? ` · ${rooms.get(l.roomId) || ''}` : '';
      return h('span', { class: `chip${inGroup ? ' selected' : ''}`, onclick: () => toggleLight(l.id) },
        `${inGroup ? '✓ ' : '+ '}${l.name}`, elsewhere && h('span', { class: 'muted' }, elsewhere));
    })),
    h('div', { class: 'label mt-10' }, h('span', {}, 'Scenes')),
    h('div', { class: 'chips' },
      g.scenes.length === 0 && h('span', { class: 'muted' }, 'No scenes yet'),
      g.scenes.map((sc) => h('span', { class: 'chip' }, sc.name,
        h('span', { class: 'chip-x', title: 'Delete scene', onclick: () => manageCall('manage:deleteScene', sc.id) }, '×')))),
    h('div', { class: 'row mt-10' },
      h('input', {
        type: 'text', maxlength: 32, placeholder: 'New scene name',
        oninput: (e) => { sceneName = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter' && sceneName.trim()) manageCall('manage:saveScene', g.id, sceneName); },
      }),
      h('button', {
        class: 'btn small',
        onclick: () => (sceneName.trim() ? manageCall('manage:saveScene', g.id, sceneName) : toast('Give the scene a name first', true)),
      }, 'Save current state as scene')));
}

function renderManage() {
  if (!S.snap) return h('p', { class: 'muted' }, S.error || 'Loading...');
  const groups = S.snap.groups.filter((g) => g.id !== '0');
  const rooms = groups.filter((g) => g.type === 'Room');
  const ng = S.newGroup;

  const create = async () => {
    if (!ng.name.trim()) return toast('Enter a name first', true);
    const id = await manageCall('manage:createGroup', { name: ng.name, type: ng.type, roomClass: ng.roomClass });
    if (id) {
      S.newGroup = { name: '', type: ng.type, roomClass: 'Other' };
      S.manageOpen.add(id);
      toast(`${ng.type} created, now add some lights`);
      render();
    }
  };

  return h('div', {},
    h('h1', {}, 'Manage'),
    h('p', { class: 'sub' }, 'Changes are saved on your bridge, so they show up in the Hue app too.'),

    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Rooms & zones'),
      groups.map((g) => {
        const open = S.manageOpen.has(g.id);
        return h('div', { class: 'manage-row' },
          h('div', { class: 'row' },
            nameInput(g.name, (name) => manageCall('manage:renameGroup', g.id, name)),
            h('span', { class: 'badge' }, g.type === 'Room' && g.class ? `Room · ${g.class}` : g.type),
            h('span', { class: 'card-meta' }, `${g.lights.length} light${g.lights.length === 1 ? '' : 's'} · ${g.scenes.length} scene${g.scenes.length === 1 ? '' : 's'}`),
            h('div', { class: 'spacer' }),
            h('button', {
              class: `btn small${open ? ' active' : ''}`,
              onclick: () => { open ? S.manageOpen.delete(g.id) : S.manageOpen.add(g.id); render(); },
            }, open ? 'Close' : 'Lights & scenes'),
            deleteButton(`group-${g.id}`, 'Delete', () => manageCall('manage:deleteGroup', g.id))),
          open && groupPanel(g));
      }),
      h('div', { class: 'row new-group' },
        h('input', { type: 'text', maxlength: 32, placeholder: 'New room or zone name', value: ng.name, oninput: (e) => { ng.name = e.target.value; }, onkeydown: (e) => e.key === 'Enter' && create() }),
        h('select', { value: ng.type, onchange: (e) => { ng.type = e.target.value; render(); } },
          h('option', { value: 'Room' }, 'Room'), h('option', { value: 'Zone' }, 'Zone')),
        ng.type === 'Room' && h('select', { value: ng.roomClass, onchange: (e) => { ng.roomClass = e.target.value; } },
          S.meta.roomClasses.map((c) => h('option', { value: c }, c))),
        h('button', { class: 'btn primary', onclick: create }, 'Create'))),

    h('div', { class: 'card mt-16' },
      h('div', { class: 'card-title' }, 'Lights'),
      S.snap.lights.map((l) => h('div', { class: `row manage-row${l.reachable ? '' : ' unreachable'}` },
        nameInput(l.name, (name) => manageCall('manage:renameLight', l.id, name)),
        h('span', { class: 'card-meta' }, l.type),
        h('div', { class: 'spacer' }),
        h('select', {
          value: l.roomId || '',
          title: 'Room',
          onchange: (e) => manageCall('manage:moveLight', l.id, e.target.value),
        }, h('option', { value: '' }, 'No room'), rooms.map((r) => h('option', { value: r.id }, r.name))),
        h('button', {
          class: 'btn small',
          title: 'Make this light blink for a few seconds',
          onclick: () => call('manage:identify', l.id).then(() => toast(`${l.name} is blinking`)).catch(() => {}),
        }, 'Identify')))));
}

// ---------- Hotkeys ----------

const KEY_MAP = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack',
};
const MODIFIER_CODES = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'];

function codeToKey(code) {
  if (KEY_MAP[code]) return KEY_MAP[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `num${m[1]}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return null;
}

function keyEventToAccelerator(e) {
  if (MODIFIER_CODES.includes(e.code)) return null;
  const key = codeToKey(e.code);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const standalone = /^F\d+$/.test(key) || key.startsWith('Media');
  if (mods.length === 0 && !standalone) return { error: 'Use at least one modifier (Ctrl / Alt / Shift / Win)' };
  return [...mods, key].join('+');
}

const prettyAccel = (a) => (a ? a.replace(/CommandOrControl/g, 'Ctrl').replace(/Super/g, 'Win').split('+').join(' + ') : 'Click to record');

function stopRecording() {
  S.recording = null;
  window.removeEventListener('keydown', onRecordKey, true);
  api.invoke('hotkeys:suspend', false).catch(() => {});
  render();
}

function onRecordKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') return stopRecording();
  const accel = keyEventToAccelerator(e);
  if (!accel) return;
  if (accel.error) return toast(accel.error, true);
  const dupe = S.hotkeyDraft.findIndex((hk, i) => i !== S.recording && hk.accelerator === accel);
  if (dupe !== -1) return toast(`${prettyAccel(accel)} is already used`, true);
  S.hotkeyDraft[S.recording].accelerator = accel;
  stopRecording();
}

function startRecording(index) {
  S.recording = index;
  api.invoke('hotkeys:suspend', true).catch(() => {});
  window.addEventListener('keydown', onRecordKey, true);
  render();
}

function hotkeyParamCell(hk) {
  if (hk.action === 'scene') {
    const gid = hk.groupId || S.config.defaultGroup || '0';
    const group = S.snap && S.snap.groups.find((g) => g.id === gid);
    const scenes = (group && group.scenes) || [];
    return h('select', { value: hk.sceneId || '', onchange: (e) => { hk.sceneId = e.target.value; } },
      h('option', { value: '' }, scenes.length ? 'Pick scene' : 'No scenes in room'),
      scenes.map((s) => h('option', { value: s.id }, gid === '0' ? `${groupName(s.group)}: ${s.name}` : s.name)));
  }
  if (hk.action === 'preset') {
    return h('select', { value: hk.preset || 'relax', onchange: (e) => { hk.preset = e.target.value; } },
      Object.entries(S.meta.presets).map(([k, label]) => h('option', { value: k }, label)));
  }
  if (hk.action === 'sleep') {
    return h('input', { type: 'number', min: 1, max: 109, class: 'w-80', value: hk.minutes || 30, oninput: (e) => { hk.minutes = Number(e.target.value); } });
  }
  return h('span', { class: 'muted' }, '');
}

function renderHotkeys() {
  if (!S.hotkeyDraft) S.hotkeyDraft = JSON.parse(JSON.stringify(S.config.hotkeys));
  const draft = S.hotkeyDraft;

  const save = async () => {
    const clean = draft.filter((hk) => hk.accelerator);
    const res = await call('hotkeys:set', clean);
    S.config = await api.invoke('config:get');
    S.hotkeyDraft = null;
    S.failedHotkeys = res.failed;
    toast(res.failed.length ? `${res.failed.length} shortcut(s) are taken by another app` : 'Hotkeys saved', res.failed.length > 0);
    render();
  };

  return h('div', {},
    h('h1', {}, 'Hotkeys'),
    h('p', { class: 'sub' }, 'Global shortcuts, they work even when Hue Desk is in the background. Click a shortcut to record a new one (Esc to cancel).'),
    h('div', { class: 'card' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Shortcut'), h('th', {}, 'Action'), h('th', {}, 'Room'), h('th', {}, 'Option'), h('th'))),
        h('tbody', {}, draft.map((hk, i) => h('tr', {},
          h('td', {}, h('span', {
            class: `kbd${S.recording === i ? ' recording' : ''}${S.failedHotkeys.includes(hk.accelerator) ? ' failed' : ''}`,
            onclick: () => (S.recording === i ? stopRecording() : startRecording(i)),
          }, S.recording === i ? 'Press keys...' : prettyAccel(hk.accelerator))),
          h('td', {}, h('select', { value: hk.action, onchange: (e) => { hk.action = e.target.value; render(); } },
            Object.entries(S.meta.actions).map(([k, label]) => h('option', { value: k }, label)))),
          h('td', {}, hk.action === 'allOff'
            ? h('span', { class: 'muted' }, 'All')
            : (() => { const sel = groupOptions(hk.groupId || '', true); sel.onchange = (e) => { hk.groupId = e.target.value || undefined; render(); }; return sel; })()),
          h('td', {}, hotkeyParamCell(hk)),
          h('td', {}, h('button', { class: 'btn small danger', onclick: () => { draft.splice(i, 1); render(); } }, 'Remove')))))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { draft.push({ accelerator: '', action: 'toggle' }); render(); } }, '+ Add hotkey'),
        h('button', { class: 'btn', onclick: () => { S.hotkeyDraft = null; render(); } }, 'Discard changes'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: save }, 'Save'))));
}

// ---------- Wake-up alarms ----------

function renderAlarms() {
  if (S.alarms == null) {
    call('alarms:list').then((a) => { S.alarms = a; render(); }).catch(() => { S.alarms = []; });
  }
  if (!S.alarmForm) {
    S.alarmForm = { groupId: S.config.defaultGroup || '0', time: '07:30', days: ['mon', 'tue', 'wed', 'thu', 'fri'], fadeMinutes: 30 };
  }
  const form = S.alarmForm;

  const create = async () => {
    if (!form.days.length) return toast('Pick at least one day', true);
    await call('alarms:create', form);
    S.alarms = null;
    toast(`Wake-up set for ${form.time}`);
    render();
  };

  const roomSelect = groupOptions(form.groupId);
  roomSelect.onchange = (e) => { form.groupId = e.target.value; };

  return h('div', {},
    h('h1', {}, 'Wake-up light'),
    h('p', { class: 'sub' }, 'Lights slowly fade in before your alarm. Stored on the bridge, so it works even when your PC is off.'),
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        roomSelect,
        h('input', { type: 'time', value: form.time, oninput: (e) => { form.time = e.target.value; } }),
        h('span', { class: 'muted' }, 'fade'),
        h('input', { type: 'number', min: 1, max: 60, class: 'w-70', value: form.fadeMinutes, oninput: (e) => { form.fadeMinutes = Number(e.target.value); } }),
        h('span', { class: 'muted' }, 'min')),
      h('div', { class: 'row' },
        h('div', { class: 'days' }, DAYS.map(([key, label]) => h('label', {},
          h('input', {
            type: 'checkbox', checked: form.days.includes(key),
            onchange: (e) => { form.days = e.target.checked ? [...form.days, key] : form.days.filter((d) => d !== key); },
          }),
          h('span', {}, label)))),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: create }, 'Add alarm'))),
    h('div', { class: 'card mt-16' },
      S.alarms == null ? h('span', { class: 'muted' }, 'Loading...')
        : S.alarms.length === 0 ? h('span', { class: 'muted' }, 'No wake-up alarms yet.')
          : S.alarms.map((a) => h('div', { class: 'row' },
            switchEl(a.enabled, async (on) => { await call('alarms:toggle', a.id, on); S.alarms = null; render(); }),
            h('strong', { class: 'big' }, a.time),
            h('span', { class: 'muted' }, `${groupName(a.groupId)} · ${a.days.map((d) => d.slice(0, 2)).join(' ')} · ${a.fadeMinutes} min fade`),
            h('div', { class: 'spacer' }),
            h('button', { class: 'btn small danger', onclick: async () => { await call('alarms:delete', a.id); S.alarms = null; render(); } }, 'Delete')))));
}

// ---------- Settings ----------

function updateText(u) {
  if (!u) return 'Loading...';
  switch (u.state) {
    case 'checking': return 'Checking for updates...';
    case 'upToDate': return 'You are on the latest version';
    case 'downloading': return `Downloading v${u.version}... ${u.percent || 0}%`;
    case 'ready': return `v${u.version} is ready to install`;
    case 'error': return `Update check failed: ${u.message}`;
    case 'unsupported': return u.message;
    default: return 'Not checked yet';
  }
}

function renderUpdateCard(c, set, row) {
  const u = S.update;
  const supported = u && u.state !== 'unsupported';
  return h('div', { class: 'card mt-16' },
    row(`Hue Desk v${S.meta.version}`, updateText(u),
      u && u.state === 'ready'
        ? h('button', { class: 'btn primary', onclick: () => call('update:install') }, 'Restart & update')
        : h('button', {
          class: 'btn',
          disabled: !supported || (u && (u.state === 'checking' || u.state === 'downloading')),
          onclick: async () => { S.update = await call('update:check'); render(); },
        }, 'Check for updates')),
    row('Automatic updates', 'Check GitHub for new versions and install them on restart',
      switchEl(c.autoUpdate, (v) => set({ autoUpdate: v }))));
}

function renderSettings() {
  const c = S.config;
  if (S.update == null) api.invoke('update:status').then((u) => { S.update = u; if (S.tab === 'settings') render(); }).catch(() => {});
  const set = async (patch) => { S.config = await call('config:set', patch); render(); };
  const roomSelect = groupOptions(c.defaultGroup || '0');
  roomSelect.onchange = (e) => set({ defaultGroup: e.target.value });

  const row = (title, desc, control) => h('div', { class: 'row py-6' },
    h('div', {}, h('div', {}, title), h('div', { class: 'card-meta' }, desc)), h('div', { class: 'spacer' }), control);

  return h('div', {},
    h('h1', {}, 'Settings'),
    h('p', { class: 'sub' }, ' '),
    h('div', { class: 'card' },
      row('Hotkey room', 'Room controlled by hotkeys and the tray menu', roomSelect),
      row('On-screen display', 'Small popup when a hotkey fires', switchEl(c.osd, (v) => set({ osd: v }))),
      row('Start with Windows', 'Launch hidden in the tray on login', switchEl(c.launchAtLogin, (v) => set({ launchAtLogin: v }))),
      row('Start hidden', 'Only show the tray icon on start', switchEl(c.startHidden, (v) => set({ startHidden: v }))),
      row('Close to tray', 'Keep running (and hotkeys active) when closing the window', switchEl(c.closeToTray, (v) => set({ closeToTray: v })))),
    renderUpdateCard(c, set, row),
    h('div', { class: 'card mt-16' },
      row('Bridge', c.bridge ? c.bridge.ip : 'Not paired',
        h('button', {
          class: 'btn danger',
          onclick: async () => { await call('bridge:forget'); await loadConfig(); S.snap = null; render(); },
        }, 'Forget bridge'))));
}

// ---------- Render ----------

function render() {
  const view = document.getElementById('view');
  const nav = document.getElementById('nav');
  const paired = S.config && S.config.bridge;
  nav.style.visibility = paired ? 'visible' : 'hidden';
  for (const b of nav.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === S.tab);

  let content;
  if (!paired) content = renderSetup();
  else if (S.tab === 'rooms') content = renderRooms();
  else if (S.tab === 'lights') content = renderLights();
  else if (S.tab === 'manage') content = renderManage();
  else if (S.tab === 'hotkeys') content = renderHotkeys();
  else if (S.tab === 'alarms') content = renderAlarms();
  else content = renderSettings();

  const scroll = view.scrollTop;
  view.replaceChildren(content);
  view.scrollTop = scroll;
}

// ---------- Boot ----------

document.getElementById('nav').addEventListener('click', (e) => {
  const tab = e.target.dataset && e.target.dataset.tab;
  if (!tab) return;
  if (S.recording != null) stopRecording();
  S.tab = tab;
  if (tab === 'alarms') S.alarms = null;
  render();
});

window.addEventListener('pointerdown', () => { S.pointerDown = true; });
window.addEventListener('pointerup', () => { S.pointerDown = false; S.interactingUntil = Date.now() + 1200; });

api.on('state-dirty', () => refresh());
api.on('update-status', (u) => {
  S.update = u;
  if (u.state === 'ready') toast(`Update v${u.version} downloaded, restart to install`);
  if (S.tab === 'settings' && !isInteracting()) render();
});

(async () => {
  await loadConfig();
  render();
  await refresh(true);
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 4000);
})();
