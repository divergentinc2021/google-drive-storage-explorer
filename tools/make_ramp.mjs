/**
 * Derive the Storage Explorer size ramp computationally (never hand-picked).
 *
 * Sequential encoding = ONE hue, light -> dark, monotone OKLCH L.
 * The light end is allowed to recede toward the surface (that is the
 * "near zero / least impact" end the brief asks to read as grey), so chroma
 * falls to ~0 there -- a near-neutral is simply C~0 of the same hue, not a
 * second hue. Anchored on the documented red so the ramp stays in-family.
 *
 * Usage: node tools/make_ramp.mjs
 */

// ---- sRGB <-> OKLab/OKLCH -------------------------------------------------
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
function rgbToHex([r, g, b]) {
  const to = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
function linToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
function oklabToLin([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
const hexToOklch = (hex) => {
  const [L, a, b] = linToOklab(hexToRgb(hex).map(srgbToLin));
  return { L, C: Math.hypot(a, b), H: (Math.atan2(b, a) * 180) / Math.PI };
};
const oklchToHex = ({ L, C, H }) => {
  const r = (H * Math.PI) / 180;
  return rgbToHex(oklabToLin([L, C * Math.cos(r), C * Math.sin(r)]).map(linToSrgb));
};
// Reduce chroma until the colour is representable in sRGB (gamut clip).
function gamutFit({ L, C, H }) {
  let lo = 0, hi = C;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const rad = (H * Math.PI) / 180;
    const lin = oklabToLin([L, mid * Math.cos(rad), mid * Math.sin(rad)]);
    if (lin.every((v) => v >= -0.0002 && v <= 1.0002)) lo = mid; else hi = mid;
  }
  return { L, C: lo, H };
}

// ---- build the ramp -------------------------------------------------------
const ANCHOR = '#e34948'; // documented categorical red (light mode)
const a = hexToOklch(ANCHOR);
console.log(`anchor ${ANCHOR} -> L=${a.L.toFixed(3)} C=${a.C.toFixed(3)} H=${a.H.toFixed(1)}\n`);

// 8 stops, near-neutral -> deep red. L strictly decreasing, C rising off ~0.
const STOPS = [
  // L evenly spaced over 0.962 -> 0.456 (gap 0.072, clears the 0.06 floor);
  // C rises off ~0 so the near-zero end reads as a neutral grey.
  { L: 0.962, C: 0.004 }, // 0  near-zero  (reads grey against the light surface)
  { L: 0.890, C: 0.030 },
  { L: 0.817, C: 0.062 },
  { L: 0.745, C: 0.098 },
  { L: 0.673, C: 0.135 },
  { L: 0.600, C: 0.172 },
  { L: 0.528, C: 0.198 },
  { L: 0.456, C: 0.180 }, // 7  largest
];
const H = a.H;
const light = STOPS.map((s) => oklchToHex(gamutFit({ ...s, H })));

// Dark mode: same hue, anchor flips -- near-zero sits just above the dark
// surface and magnitude climbs toward a bright red.
const STOPS_DARK = [
  { L: 0.260, C: 0.012 },
  { L: 0.330, C: 0.045 },
  { L: 0.400, C: 0.080 },
  { L: 0.470, C: 0.115 },
  { L: 0.540, C: 0.150 },
  { L: 0.610, C: 0.180 },
  { L: 0.680, C: 0.185 },
  { L: 0.760, C: 0.155 },
];
const dark = STOPS_DARK.map((s) => oklchToHex(gamutFit({ ...s, H })));

const show = (name, arr) => {
  console.log(name);
  arr.forEach((hex, i) => {
    const o = hexToOklch(hex);
    console.log(`  ${i}  ${hex}   L=${o.L.toFixed(3)} C=${o.C.toFixed(3)}`);
  });
  console.log(`  => "${arr.join(',')}"\n`);
};
show('SIZE ramp / light', light);
show('SIZE ramp / dark', dark);
