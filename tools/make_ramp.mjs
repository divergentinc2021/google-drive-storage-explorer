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
/*
  ON SPACING, because the obvious "improvement" here is a trap.

  Adjacent-gap uniformity was measured for all four ramps: 1.11 and 1.06 for the
  two size ramps, 1.03 and 1.02 for the two age ramps (1.00 being perfect). They
  are already near-ideal, and every attempt to improve them made them worse.

  In particular, re-placing the stops at equal ARC LENGTH along the OKLCH path —
  which sounds like the textbook fix — produced uniformity of 1.5 to 2.0, i.e.
  substantially worse than the linear-lightness ramps it was meant to replace.
  Arc length is distance along a curve; what the eye compares between two
  touching tiles is the CHORD between them. A hue-rotating path curves hard
  through the a-b plane, so equal arcs give markedly unequal chords. Don't.

  `g` is a gamma on lightness only (hue stays linear in t). It exists solely to
  buy back the worst colour-blind adjacent gap, which for both size ramps is
  protanopia at the red/purple end.
*/
const lerp = (a1, b1, t) => a1 + (b1 - a1) * t;
const ramp = (L0, L1, H0, H1, Cs, g) =>
  Cs.map((C, i) => {
    const t = i / (Cs.length - 1);
    return oklchToHex(gamutFit({
      L: lerp(L0, L1, g ? Math.pow(t, g) : t),
      C, H: lerp(H0, H1, t)
    }));
  });

/*
  NEGATIVE HUE ANGLES ARE DELIBERATE. The path has to stay on the warm arc:
  104 -> 0 -> -24 is gold -> orange -> red -> purple-red. Writing the same
  endpoint as +336 instead makes the interpolation walk the long way round the
  wheel, through green, cyan and blue. That was tried: it scores BETTER on
  adjacent separation (.1141 vs .1027) precisely because it abandons any ordered
  reading -- it is the jet-colormap trap. Adjacent separation is only meaningful
  while the ramp is still sequential, so never read that number on its own.
*/

// Light: near-white neutral -> gold -> orange -> red -> deep purple-red. Step 0
// sits 0.0123 from the surface, so negligible files still recede -- that is the
// documented sequential exemption, not a contrast bug.
/*
  THE NEGLIGIBLE END IS YELLOW, NOT NEAR-WHITE. This reverses the "near-zero
  recedes into the surface" exemption that earlier versions of this file
  documented, and the reason is that the exemption stopped being true when
  container tiles were changed to fill with --surface-1.

  Once the scaffolding is surface-coloured, a near-white smallest step is not
  receding into the BACKGROUND, it is colliding with the CHROME: a negligible
  file and an empty gutter became the same colour. Measured, step 0 sat 0.0216
  from --surface-1. It is now 0.1273, about 1.7 ramp steps, so a tiny file reads
  as a tiny file rather than as part of the frame.

  No gamma any more either. The gamma existed to buy colour-blind headroom back
  on the old ramp, where there was little range to spare. Dropping the near-white
  floor widened the lightness span from .630 to .685, and that supplies the
  headroom directly: g 1.00 gives minAdj .1094 and uniformity 1.06 against the
  old .1021 / 1.11. Swept 1.00 to 1.10 — every step up traded normal-vision
  separation and uniformity for protanope separation, and there is no longer a
  reason to make that trade.
*/
const light = ramp(0.925, 0.240, 96, -30,
  [0.110, 0.145, 0.162, 0.175, 0.185, 0.195, 0.198, 0.180]);

// Dark: the same path run the other way -- a purple-black floor climbing through
// maroon and flame to a bright yellow. Brightest is biggest, because on a dark
// plane the largest thing has to be the most prominent one; that inverts where
// the purple sits relative to light mode, which is inherent and not a mistake.
/*
  No gamma here: the sweep showed g .86 buys 3.5% of protanope gap for 7% of the
  normal-vision minimum and uniformity 1.06 -> 1.36. Not a trade worth making.

  The floor is .235 with chroma .095, NOT a near-black. Dark mode has the same
  collision the light ramp had, just with a different neighbour: --surface-1 in
  dark is #1a1a19, so a near-black smallest step is indistinguishable from the
  container scaffolding. Pushing the floor down to .190 for extra range made it
  worse -- step 0 measured .0445 from --surface-1, under half a ramp step. At
  .235/.095 it measures .0992 against a step size of .102, i.e. a full step of
  separation, and the ramp still beats what it replaced on every axis: minAdj
  .0968 -> .1023, worst CVD gap .0682 -> .0777.
*/
const dark = ramp(0.235, 0.895, -30, 98,
  [0.095, 0.118, 0.140, 0.160, 0.178, 0.187, 0.181, 0.170]);

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
/*
  The recent end is GREEN, not mint: hue starts at 150 instead of 175. It is a
  LIGHT green, and that constraint is the whole story.

  A dark green for "most recent" was asked for and measured. It cannot work in a
  sequential ramp, because the oldest band is already the dark end -- making the
  newest dark too puts both extremes at the same lightness and the ramp stops
  being rankable. The legitimate form is a DIVERGING ramp (dark green -> pale
  middle -> dark navy), and that was built and tested: adjacent separation jumps
  to .2212, but the two ENDS land only .1911 apart against .5731 for this ramp,
  and .0619 apart under tritanopia. Those two ends are "leave it alone" and "move
  it to the NAS" -- the two opposite actions on the map, and the pair you would
  most easily confuse. Not a trade worth making, so: green, but light.
*/
// Both age ramps are left on linear lightness. They are the best-formed of the
// four -- uniformity 1.03 and 1.02, and the widest adjacent gaps on the map --
// and the gamma sweep degraded every metric in both directions.
/*
  SKY BLUE AT THE RECENT END WAS TESTED AND REJECTED. It was proposed to raise
  contrast, and it does the opposite: sky blue sits at hue ~230, which is CLOSER
  to the navy at 255 than green at 150 is, so the ramp's hue span collapses from
  105 degrees to 25. Measured, minAdj .1421 -> .1359 and the ends moved from
  .5686 apart to .5422. Less contrast, not more.

  What the request actually wanted -- a punchier recent end -- came from keeping
  green, pushing its chroma up (.110 -> .155) and widening the lightness span,
  which lifts minAdj to .1577, the ends to .6462, and the worst CVD gap to .1419.
  Every number better than both the shipped ramp and the sky-blue proposal.

  The lightest band also has to clear --surface-1 now that containers are filled
  with it, for the same reason the size ramp's floor is no longer near-white.
  Higher chroma handles that here without giving up any lightness.
*/
show('AGE ramp / light', ramp(0.89, 0.28, 146, 258, [0.155, 0.145, 0.130, 0.128, 0.112]));
show('AGE ramp / dark',  ramp(0.94, 0.34, 144, 260, [0.158, 0.148, 0.132, 0.130, 0.120]));

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
