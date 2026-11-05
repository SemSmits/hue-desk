'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockBridge } = require('./mock-bridge');
const { HueClient } = require('../src/hue');
const { createActionRunner } = require('../src/actions');
const { buildWakeSchedule, parseAlarms, shiftMaskBack, daysToMask } = require('../src/alarms');
const { hexToXy, kelvinToMired } = require('../src/color');

async function setup() {
  const bridge = await startMockBridge();
  const client = new HueClient(bridge.host, 'test-user');
  const results = [];
  const runner = createActionRunner({
    getClient: () => client,
    getDefaultGroup: () => '1',
    getSnapshot: () => client.snapshot(),
    onDone: (r) => r && results.push(r),
  });
  return { bridge, client, runner, results };
}

test('pairing fails with 101 until link button is pressed', async () => {
  const bridge = await startMockBridge();
  try {
    await assert.rejects(HueClient.pair(bridge.host), (err) => err.type === 101);
    bridge.state.linkPressed = true;
    assert.equal(await HueClient.pair(bridge.host), 'test-user');
  } finally {
    bridge.close();
  }
});

test('unauthorized username surfaces as HueError type 1', async () => {
  const bridge = await startMockBridge();
  try {
    await assert.rejects(new HueClient(bridge.host, 'nope').snapshot(), (err) => err.type === 1);
  } finally {
    bridge.close();
  }
});

test('snapshot builds rooms, zones, all-lights group and capabilities', async () => {
  const { bridge, client } = await setup();
  try {
    const snap = await client.snapshot();
    assert.deepEqual(snap.groups.map((g) => g.name), ['All lights', 'Bedroom', 'Desk']); // entertainment excluded
    const bedroom = snap.groups.find((g) => g.id === '1');
    assert.equal(bedroom.hasColor, true);
    assert.equal(bedroom.hasCt, true);
    assert.deepEqual(bedroom.scenes.map((s) => s.name), ['Bright', 'Chill']);
    assert.equal(snap.groups[0].lights.length, 3);
    const hallway = snap.lights.find((l) => l.id === '3');
    assert.equal(hallway.reachable, false);
    assert.equal(hallway.hasColor, false);
  } finally {
    bridge.close();
  }
});

test('toggle flips the default group', async () => {
  const { bridge, runner } = await setup();
  try {
    let r = await runner.run({ action: 'toggle' });
    assert.equal(r.value, 'Off');
    assert.equal(bridge.state.groups[1].state.any_on, false);
    r = await runner.run({ action: 'toggle' });
    assert.equal(r.value, 'On');
  } finally {
    bridge.close();
  }
});

test('brightness up/down clamps and reports percent', async () => {
  const { bridge, runner } = await setup();
  try {
    let r = await runner.run({ action: 'brightnessUp' });
    assert.equal(bridge.state.groups[1].action.bri, 225);
    r = await runner.run({ action: 'brightnessUp' });
    r = await runner.run({ action: 'brightnessUp' });
    assert.equal(bridge.state.groups[1].action.bri, 254);
    assert.equal(r.percent, 100);
    await runner.run({ action: 'brightnessDown', groupId: '2' });
    assert.equal(bridge.state.groups[2].action.bri, 175);
  } finally {
    bridge.close();
  }
});

test('brightness down on a room that is off does nothing', async () => {
  const { bridge, runner } = await setup();
  try {
    await runner.run({ action: 'toggle' });
    const before = bridge.state.calls.length;
    const r = await runner.run({ action: 'brightnessDown' });
    assert.equal(r.value, 'Off');
    assert.equal(bridge.state.calls.filter((c, i) => i >= before && c.method === 'PUT').length, 0);
  } finally {
    bridge.close();
  }
});

test('next/prev scene cycles through the room scenes', async () => {
  const { bridge, runner } = await setup();
  try {
    assert.equal((await runner.run({ action: 'nextScene' })).value, 'Bright');
    assert.equal((await runner.run({ action: 'nextScene' })).value, 'Chill');
    assert.equal((await runner.run({ action: 'nextScene' })).value, 'Bright');
    assert.equal((await runner.run({ action: 'prevScene' })).value, 'Chill');
    const sceneCalls = bridge.state.calls.filter((c) => c.body && c.body.scene);
    assert.deepEqual(sceneCalls.map((c) => c.body.scene), ['s1', 's2', 's1', 's2']);
  } finally {
    bridge.close();
  }
});

test('scene cycling on "All lights" recalls via the scene own group', async () => {
  const { bridge, runner } = await setup();
  try {
    await runner.run({ action: 'nextScene', groupId: '0' });
    const call = bridge.state.calls.find((c) => c.body && c.body.scene);
    assert.match(call.url, /\/groups\/1\/action$/);
  } finally {
    bridge.close();
  }
});

test('colorloop toggles on and off', async () => {
  const { bridge, runner } = await setup();
  try {
    assert.equal((await runner.run({ action: 'colorloop' })).value, 'Party mode on');
    assert.equal(bridge.state.groups[1].action.effect, 'colorloop');
    assert.equal((await runner.run({ action: 'colorloop' })).value, 'Party mode off');
    assert.equal(bridge.state.groups[1].action.effect, 'none');
  } finally {
    bridge.close();
  }
});

test('sleep timer fades out and can be cancelled', async () => {
  const { bridge, runner } = await setup();
  try {
    const r = await runner.run({ action: 'sleep', minutes: 15 });
    assert.equal(r.value, 'Sleep in 15 min');
    const fade = bridge.state.calls.find((c) => c.body && c.body.transitiontime === 9000);
    assert.ok(fade, 'expected a 15 min (9000 ds) fade');
    assert.ok(runner.getSleepTimers()['1'] > Date.now());
    await runner.run({ action: 'cancelSleep' });
    assert.deepEqual(runner.getSleepTimers(), {});
    assert.equal(bridge.state.groups[1].action.bri, 200);
    assert.equal(bridge.state.groups[1].state.any_on, true);
  } finally {
    bridge.close();
  }
});

test('preset applies state, allOff targets group 0', async () => {
  const { bridge, runner } = await setup();
  try {
    await runner.run({ action: 'preset', preset: 'nightlight' });
    assert.equal(bridge.state.groups[1].action.bri, 1);
    assert.equal(bridge.state.groups[1].action.ct, 500);
    await runner.run({ action: 'allOff' });
    assert.equal(bridge.state.group0.state.any_on, false);
  } finally {
    bridge.close();
  }
});

test('wake-up schedule starts fade early and wraps days over midnight', () => {
  const s = buildWakeSchedule({ username: 'u', groupId: '1', time: '07:00', days: ['mon', 'fri'], fadeMinutes: 30 });
  assert.equal(s.localtime, 'W68/T06:30:00');
  assert.equal(s.command.address, '/api/u/groups/1/action');
  assert.equal(s.command.body.transitiontime, 18000);

  // 00:10 Monday with 30 min fade -> starts 23:40 on Sunday
  const early = buildWakeSchedule({ username: 'u', groupId: '1', time: '00:10', days: ['mon'], fadeMinutes: 30 });
  assert.equal(early.localtime, 'W1/T23:40:00');
  assert.equal(shiftMaskBack(daysToMask(['tue', 'sun'])), daysToMask(['mon', 'sat']));
});

test('alarms round-trip through the bridge', async () => {
  const { bridge, client } = await setup();
  try {
    await client.createSchedule(buildWakeSchedule({ username: 'test-user', groupId: '1', time: '07:30', days: ['sat'], fadeMinutes: 20 }));
    await client.createSchedule({ name: 'Other app', description: 'not ours', localtime: 'W1/T10:00:00', command: {} });
    const alarms = parseAlarms(await client.getSchedules());
    assert.equal(alarms.length, 1);
    assert.deepEqual(alarms[0], { id: '1', time: '07:30', fadeMinutes: 20, groupId: '1', days: ['sat'], enabled: true });
    await client.updateSchedule('1', { status: 'disabled' });
    assert.equal(parseAlarms(await client.getSchedules())[0].enabled, false);
    await client.deleteSchedule('1');
    assert.equal(parseAlarms(await client.getSchedules()).length, 0);
  } finally {
    bridge.close();
  }
});

test('color helpers', () => {
  const [x, y] = hexToXy('#ff0000');
  assert.ok(x > 0.6 && y < 0.35, `red should map to high x, got ${x},${y}`);
  assert.deepEqual(hexToXy('#000000'), [0.3227, 0.329]);
  assert.throws(() => hexToXy('nope'));
  assert.equal(kelvinToMired(2700), 370);
  assert.equal(kelvinToMired(10000), 153);
});
