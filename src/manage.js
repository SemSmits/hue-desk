'use strict';

/**
 * Bridge management: renaming, rooms/zones, light membership and scenes.
 * Everything is stored on the bridge, so changes also show up in the Hue app.
 */

const MAX_NAME = 32;
const ROOM_CLASSES = [
  'Living room', 'Kitchen', 'Dining', 'Bedroom', 'Kids bedroom', 'Bathroom',
  'Office', 'Hallway', 'Toilet', 'Garage', 'Gym', 'Other',
];

function cleanName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Name cannot be empty');
  if (trimmed.length > MAX_NAME) throw new Error(`Name can be at most ${MAX_NAME} characters`);
  return trimmed;
}

function createManager(getClient) {
  const client = () => {
    const c = getClient();
    if (!c) throw new Error('No bridge paired yet');
    return c;
  };

  async function getGroups() {
    return client().request('GET', '/groups');
  }

  /**
   * A light can only be in one Room. Before adding lights to a room, remove them
   * from any other room so the bridge doesn't reject the update.
   */
  async function releaseFromOtherRooms(lightIds, exceptGroupId) {
    const groups = await getGroups();
    for (const [gid, g] of Object.entries(groups)) {
      if (gid === exceptGroupId || g.type !== 'Room') continue;
      const remaining = (g.lights || []).filter((lid) => !lightIds.includes(lid));
      if (remaining.length !== (g.lights || []).length) {
        await client().updateGroup(gid, { lights: remaining });
      }
    }
  }

  return {
    async renameLight(id, name) {
      await client().updateLight(id, { name: cleanName(name) });
    },

    async renameGroup(id, name) {
      if (id === '0') throw new Error('"All lights" cannot be renamed');
      await client().updateGroup(id, { name: cleanName(name) });
    },

    async createGroup({ name, type = 'Room', roomClass = 'Other', lights = [] }) {
      if (!['Room', 'Zone'].includes(type)) throw new Error(`Unsupported group type: ${type}`);
      const body = { name: cleanName(name), type, lights: lights.map(String) };
      if (type === 'Room') {
        body.class = ROOM_CLASSES.includes(roomClass) ? roomClass : 'Other';
        if (body.lights.length) await releaseFromOtherRooms(body.lights, null);
      }
      const res = await client().createGroup(body);
      return res[0].success.id;
    },

    async deleteGroup(id) {
      if (id === '0') throw new Error('"All lights" cannot be deleted');
      await client().deleteGroup(id);
    },

    async setGroupLights(id, lights) {
      if (id === '0') throw new Error('"All lights" always contains every light');
      const ids = lights.map(String);
      const groups = await getGroups();
      const group = groups[id];
      if (!group) throw new Error(`Group ${id} not found`);
      if (group.type === 'Room' && ids.length) await releaseFromOtherRooms(ids, id);
      await client().updateGroup(id, { lights: ids });
    },

    /** Moves a light to another room, or out of all rooms when roomId is empty. */
    async moveLight(lightId, roomId) {
      const id = String(lightId);
      await releaseFromOtherRooms([id], roomId || null);
      if (!roomId) return;
      const groups = await getGroups();
      const room = groups[roomId];
      if (!room || room.type !== 'Room') throw new Error('Target is not a room');
      if (!room.lights.includes(id)) await client().updateGroup(roomId, { lights: [...room.lights, id] });
    },

    /** Saves the current state of every light in the group as a new scene. */
    async saveScene(groupId, name) {
      if (groupId === '0') throw new Error('Pick a room or zone to save a scene for');
      const res = await client().createScene({ name: cleanName(name), type: 'GroupScene', group: groupId, recycle: false });
      return res[0].success.id;
    },

    async deleteScene(id) {
      await client().deleteScene(id);
    },

    async identifyLight(id) {
      await client().setLight(id, { alert: 'lselect' });
      const t = setTimeout(() => client().setLight(id, { alert: 'none' }).catch(() => {}), 5000);
      if (t.unref) t.unref();
    },
  };
}

module.exports = { createManager, cleanName, ROOM_CLASSES, MAX_NAME };
