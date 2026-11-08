'use strict';

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = document.getElementById('error');
  const button = e.target.querySelector('button');
  error.textContent = '';
  button.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    const data = await res.json();
    if (data.ok) {
      window.location.href = '/';
      return;
    }
    error.textContent = data.error || 'Login failed';
  } catch {
    error.textContent = 'Could not reach Hue Desk. Is it still running on the PC?';
  }
  button.disabled = false;
});
