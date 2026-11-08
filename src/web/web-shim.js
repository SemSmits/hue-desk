'use strict';

/**
 * Browser replacement for the Electron preload: same window.hue API,
 * but over HTTP (invoke) and Server-Sent Events (on).
 */
(() => {
  const listeners = {};

  async function invoke(channel, ...args) {
    // Pausing global hotkeys only makes sense on the PC itself
    if (channel === 'hotkeys:suspend') return true;
    const res = await fetch('/api/invoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Hue-Desk': '1' },
      body: JSON.stringify({ channel, args }),
    });
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('Not logged in');
    }
    const data = await res.json();
    if (!data.ok) {
      const err = new Error(data.error);
      err.type = data.type;
      throw err;
    }
    return data.data;
  }

  function on(channel, fn) {
    (listeners[channel] = listeners[channel] || []).push(fn);
  }

  const events = new EventSource('/api/events');
  for (const channel of ['state-dirty', 'update-status']) {
    events.addEventListener(channel, (e) => {
      const payload = e.data ? JSON.parse(e.data) : null;
      (listeners[channel] || []).forEach((fn) => fn(payload));
    });
  }

  async function logout() {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-Hue-Desk': '1' } });
    window.location.href = '/login';
  }

  window.hue = { invoke, on, logout, isWeb: true };
})();
