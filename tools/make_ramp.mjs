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

/*
  8 stops, MULTI-HUE: a black-body path (yellow -> orange -> red) rather than one
  red hue, with L strictly monotone and C rising off ~0 at the near-zero end.

  Why hue was added. The static gain looks small on flat swatches -- minimum
  adjacent OKLab distance .0744 -> .0874 in light mode. The real reason is that
  the treemap now shades every tile: measured on the preview, relief + ambient
  occlusion swing lightness WITHIN a single tile by a median of 2.44 adjacent
  ramp steps (p90 3.18). The tile's mean is normalised so it still lands on the
  right step, but locally lightness is dominated by shape. Hue is the one channel
  the shading cannot touch, so a hue-varying ramp keeps discriminating where a
  purely lightness-varying one is being drowned out by its own 3D.

  Monotone L is non-negotiable: it is what keeps the ramp rankable AND what makes
  it degrade to a usable greyscale ramp under red-green CVD -- which matters
  doubly here, because yellow-orange-red is exactly the axis that CVD compresses.
  Both simulations improve against the old ramp (deuteranopia .0685 -> .0786,
  protanopia .0639 -> .0856).
*/
const lerp = (a1, b1, t) => a1 + (b1 - a1) * t;
const ramp = (L0, L1, H0, H1, Cs) =>
  Cs.map((C, i) => {
    const t = i / (Cs.length - 1);
    return oklchToHex(gamutFit({ L: lerp(L0, L1, t), C, H: lerp(H0, H1, t) }));
  });

// Light: near-white neutral -> gold -> orange -> deep red. Step 0 sits 0.0123
// from the surface, so negligible files still recede -- that is the documented
// sequential exemption, and the multi-hue version tightened it rather than
// losing it.
const light = ramp(0.970, 0.400, 102, 20,
  [0.004, 0.075, 0.125, 0.150, 0.165, 0.180, 0.195, 0.180]);

// Dark: the same path run the other way -- near-black just above the surface,
// climbing through maroon and orange to a bright yellow. Brightest is biggest,
// the direction the dark ramp already used; only the hue path is new.
const dark = ramp(0.260, 0.840, 20, 92,
  [0.012, 0.055, 0.095, 0.135, 0.165, 0.180, 0.175, 0.165]);

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

/*
  AGE ramp — ordinal, five bands, multi-hue.
  Hue rotates monotonically WHILE L falls monotonically; that pairing is what
  keeps it rankable by eye and what makes it degrade to a usable greyscale ramp
  under red-green CVD. A version with the same colours at co-equal lightness was
  measured and rejected: higher mean separation, but not L-monotone under either
  deuteranopia or protanopia, and not rankable without consulting the legend.
*/
const ageStops = (Ls, Cs) => Ls.map((L, i) => oklchToHex(gamutFit({ L, C: Cs[i], H: AGE_H[i] })));
const AGE_H = [175, 195, 215, 235, 255];
show('AGE ramp / light', ageStops([0.88, 0.74, 0.60, 0.46, 0.32], [0.075, 0.105, 0.120, 0.130, 0.110]));
show('AGE ramp / dark',  ageStops([0.90, 0.79, 0.68, 0.57, 0.46], [0.070, 0.100, 0.115, 0.125, 0.115]));

// Minimum adjacent separation is the number that matters — a ramp is only as
// readable as its closest neighbouring pair, since that is the comparison two
// touching tiles force you to make. Mean separation hides exactly that.
const oklabOf = (hex) => linToOklab(hexToRgb(hex).map(srgbToLin));
const minAdj = (arr) => Math.min(...arr.slice(1).map((h, i) => {
  const a = oklabOf(arr[i]), b = oklabOf(h);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}));
console.log('min adjacent OKLab distance');
console.log(`  SIZE light ${minAdj(light).toFixed(4)}   SIZE dark ${minAdj(dark).toFixed(4)}`);
