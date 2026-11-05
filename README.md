# Hue Desk

Desktop app (Electron) to control Philips Hue lights from your PC: rooms, scenes, brightness, global hotkeys, tray menu, sleep timer and wake-up light.

## Getting started

```bash
npm install
npm start
```

1. Click **Search network** (or enter the bridge IP manually, find it in the Hue app under Settings > Bridges).
2. Press the round link button on the bridge, then click **Pair** within 30 seconds.
3. Done. Your username is stored in `%APPDATA%/hue-desk/config.json`.

## Installer (.exe)

**Easiest:** double-click `build-installer.bat`. It installs everything, runs the tests and puts two files in `dist/`:

- `HueDesk-Setup-1.0.0.exe`: installer with Start menu + desktop shortcut and uninstaller
- `HueDesk-Portable-1.0.0.exe`: single exe, no install needed

Or manually: `npm install && npm run dist`

## Features

- **Rooms & zones**: on/off, brightness, white temperature, color picker, scenes, presets
- **Individual lights**: per-bulb control, unreachable bulbs are greyed out
- **Manage**: rename lights, rooms and zones, create/delete rooms and zones, move lights between rooms, save the current state as a scene, delete scenes, make a light blink to identify it. Stored on the bridge, so the Hue app sees it too
- **Global hotkeys**: fully configurable, record any combo in the Hotkeys tab
- **On-screen display**: small popup at the bottom of your screen when a hotkey fires (with brightness bar)
- **Tray menu**: toggle, scenes, presets, sleep timer, pause hotkeys (e.g. while gaming)
- **Sleep timer**: fades a room out over X minutes
- **Wake-up light**: fades a room in before your alarm, stored on the bridge so it works with the PC off
- **Party mode**: color loop effect
- **Blink**: makes a room flash so you can see which one it is
- **Start with Windows**, start hidden, close to tray
- **Auto-updates**: checks GitHub Releases every 6 hours, downloads in the background and installs on restart (installer version only, not the portable exe)

## Default hotkeys

| Shortcut | Action |
|---|---|
| Ctrl + Alt + L | Toggle hotkey room |
| Ctrl + Alt + Up / Down | Brightness +/- 10% |
| Ctrl + Alt + Right / Left | Next / previous scene |
| Ctrl + Alt + O | All lights off |
| Ctrl + Alt + N | Nightlight preset |
| Ctrl + Alt + F | Concentrate preset |
| Ctrl + Alt + P | Party mode |
| Ctrl + Alt + S | Sleep timer (30 min) |

The "hotkey room" is set with the **Set as target** button on a room card, or per hotkey in the Hotkeys tab.

## Development

```bash
npm test                     # tests against a fake bridge
node test/mock-bridge.js 8080  # run a fake bridge, pair with IP 127.0.0.1:8080
```

## Structure

```
src/
  main.js        Electron main: windows, tray, global shortcuts, IPC
  preload.js     Safe IPC bridge for the renderer
  hue.js         Hue bridge client (local v1 API) + data model
  actions.js     Shared actions for hotkeys, tray and UI
  alarms.js      Wake-up schedules stored on the bridge
  manage.js      Renaming, rooms/zones, light membership, scenes
  updater.js     Auto-updates via GitHub Releases
  color.js       Hex to CIE xy conversion
  store.js       JSON config
  renderer/      UI
  osd/           On-screen display popup
test/            Tests + mock bridge
```
