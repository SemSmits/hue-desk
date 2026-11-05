'use strict';

/** Converts a #rrggbb hex color to CIE xy, as used by the Hue API. */
function hexToXy(hex) {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error(`Invalid hex color: ${hex}`);
  const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);

  // Gamma correction (sRGB -> linear)
  const [r, g, b] = channels.map((c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92));

  // Wide gamut D65 conversion
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3227, 0.329]; // black -> neutral white point

  return [Number((X / sum).toFixed(4)), Number((Y / sum).toFixed(4))];
}

/** Hue uses mireds (153 = cold 6500K, 500 = warm 2000K). */
function kelvinToMired(kelvin) {
  return Math.max(153, Math.min(500, Math.round(1e6 / kelvin)));
}

function miredToKelvin(mired) {
  return Math.round(1e6 / mired);
}

module.exports = { hexToXy, kelvinToMired, miredToKelvin };
