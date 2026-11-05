'use strict';

/**
 * Wake-up alarms are stored as schedules ON THE BRIDGE, so they fire even
 * when your PC is off. The light fade starts `fadeMinutes` before wake time.
 */

const DAY_BITS = { mon: 64, tue: 32, wed: 16, thu: 8, fri: 4, sat: 2, sun: 1 };
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TAG = 'hue-desk';

function daysToMask(days) {
  return days.reduce((mask, d) => mask | (DAY_BITS[d] || 0), 0);
}

function maskToDays(mask) {
  return DAY_ORDER.filter((d) => mask & DAY_BITS[d]);
}

/** Moves every selected day one day back (Mon -> Sun, Tue -> Mon, ...). */
function shiftMaskBack(mask) {
  return ((mask << 1) & 127) | (mask & 64 ? 1 : 0);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function buildWakeSchedule({ username, groupId, time, days, fadeMinutes = 30, ct = 233 }) {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error('Time must be HH:MM');
  if (!days || days.length === 0) throw new Error('Select at least one day');
  const fade = Math.max(1, Math.min(60, Math.round(fadeMinutes)));

  const [h, m] = time.split(':').map(Number);
  let startMinutes = h * 60 + m - fade;
  let mask = daysToMask(days);
  if (startMinutes < 0) {
    startMinutes += 24 * 60;
    mask = shiftMaskBack(mask);
  }
  const start = `${pad(Math.floor(startMinutes / 60))}:${pad(startMinutes % 60)}:00`;

  return {
    name: 'Wake up',
    description: `${TAG}|${time}|${fade}|${groupId}|${days.join(',')}`,
    localtime: `W${mask}/T${start}`,
    status: 'enabled',
    autodelete: false,
    command: {
      address: `/api/${username}/groups/${groupId}/action`,
      method: 'PUT',
      body: { on: true, bri: 254, ct, transitiontime: fade * 600 },
    },
  };
}

function parseAlarms(schedules) {
  return Object.entries(schedules || {})
    .filter(([, s]) => typeof s.description === 'string' && s.description.startsWith(`${TAG}|`))
    .map(([id, s]) => {
      const [, time, fade, groupId, days] = s.description.split('|');
      return {
        id,
        time,
        fadeMinutes: Number(fade),
        groupId,
        days: days ? days.split(',') : [],
        enabled: s.status === 'enabled',
      };
    })
    .sort((a, b) => a.time.localeCompare(b.time));
}

module.exports = { buildWakeSchedule, parseAlarms, daysToMask, maskToDays, shiftMaskBack, DAY_ORDER };
