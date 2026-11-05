'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockBridge } = require('./mock-bridge');
const { HueClient } = require('../src/hue');
const { createManager, cleanName } = require('../src/manage');

async function setup() {
  const bridge = await startMockBridge();
  const client = new HueClient(bridge.host, 'test-user');
  return { bridge, client, manager: createManager(() => client) };
}

test('name validation', () => {
  assert.equal(cleanName('  Desk lamp  '), 'Desk lamp');
  assert.throws(() => cleanName('   '), /empty/);
  assert.throws(() => cleanName('x'.repeat(33)), /32/);
});

test('rename light and group', async () => {
  const { bridge, client, manager } = await setup();
  try {
    await manager.renameLight('1', 'Monitor bar');
    await manager.renameGroup('1', 'Slaapkamer');
    const snap = await client.snapshot();
    assert.equal(snap.lights.find((l) => l.id === '1').name, 'Monitor bar');
    assert.equal(snap.groups.find((g) => g.id === '1').name, 'Slaapkamer');
    await assert.rejects(manager.renameGroup('0', 'x'), /cannot be renamed/);
  } finally {
    bridge.close();
  }
});

test('lights report their room', async () => {
  const { bridge, client } = await setup();
  try {
    const snap = await client.snapshot();
    assert.equal(snap.lights.find((l) => l.id === '1').roomId, '1');
    assert.equal(snap.lights.find((l) => l.id === '3').roomId, undefined);
  } finally {
    bridge.close();
  }
});

test('creating a room with a light moves it out of its old room', async () => {
  const { bridge, client, manager } = await setup();
  try {
    const id = await manager.createGroup({ name: 'Studeerkamer', type: 'Room', roomClass: 'Office', lights: ['2'] });
    assert.deepEqual(bridge.state.groups[id].lights, ['2']);
    assert.equal(bridge.state.groups[id].class, 'Office');
    assert.deepEqual(bridge.state.groups[1].lights, ['1']);
    const snap = await client.snapshot();
    assert.equal(snap.lights.find((l) => l.id === '2').roomId, id);
  } finally {
    bridge.close();
  }
});

test('zones can share lights with rooms', async () => {
  const { bridge, manager } = await setup();
  try {
    const id = await manager.createGroup({ name: 'Gaming corner', type: 'Zone', lights: ['1', '2'] });
    assert.deepEqual(bridge.state.groups[id].lights, ['1', '2']);
    assert.deepEqual(bridge.state.groups[1].lights, ['1', '2'], 'room untouched');
    assert.equal(bridge.state.groups[id].class, undefined);
  } finally {
    bridge.close();
  }
});

test('moveLight and setGroupLights respect room exclusivity', async () => {
  const { bridge, manager } = await setup();
  try {
    const roomId = await manager.createGroup({ name: 'Hall', type: 'Room' });
    await manager.moveLight('1', roomId);
    assert.deepEqual(bridge.state.groups[roomId].lights, ['1']);
    assert.deepEqual(bridge.state.groups[1].lights, ['2']);

    await manager.setGroupLights('1', ['1', '2', '3']);
    assert.deepEqual(bridge.state.groups[1].lights, ['1', '2', '3']);
    assert.deepEqual(bridge.state.groups[roomId].lights, []);

    await manager.moveLight('3', '');
    assert.deepEqual(bridge.state.groups[1].lights, ['1', '2']);
    await assert.rejects(manager.moveLight('1', '2'), /not a room/);
  } finally {
    bridge.close();
  }
});

test('delete group', async () => {
  const { bridge, manager } = await setup();
  try {
    await manager.deleteGroup('2');
    assert.equal(bridge.state.groups[2], undefined);
    await assert.rejects(manager.deleteGroup('0'), /cannot be deleted/);
  } finally {
    bridge.close();
  }
});

test('save and delete scenes', async () => {
  const { bridge, client, manager } = await setup();
  try {
    const id = await manager.saveScene('1', 'Late night');
    assert.equal(bridge.state.scenes[id].type, 'GroupScene');
    assert.equal(bridge.state.scenes[id].group, '1');
    let snap = await client.snapshot();
    assert.ok(snap.groups.find((g) => g.id === '1').scenes.some((s) => s.name === 'Late night'));
    await manager.deleteScene(id);
    snap = await client.snapshot();
    assert.ok(!snap.groups.find((g) => g.id === '1').scenes.some((s) => s.name === 'Late night'));
    await assert.rejects(manager.saveScene('0', 'x'), /room or zone/);
  } finally {
    bridge.close();
  }
});

test('identify blinks a light', async () => {
  const { bridge, manager } = await setup();
  try {
    await manager.identifyLight('2');
    assert.equal(bridge.state.lights[2].state.alert, 'lselect');
  } finally {
    bridge.close();
  }
});
