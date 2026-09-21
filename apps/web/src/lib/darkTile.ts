/**
 * OSM's light tiles turned over for a dark theme, pixel by pixel, once per
 * tile as it loads. The same look used to come from a CSS filter over the
 * tile pane, which the browser redraws on every frame of a zoom; baked into
 * the tile it costs a couple of milliseconds, once.
 *
 * The steps are CSS's, in order, each clamped as CSS clamps it:
 * invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.88) saturate(0.55).
 * Inverting turns light land dark and keeps its hue opposite; the half-turn
 * of hue brings water back to blue and parks back to green.
 */

const BRIGHTNESS = 0.92;
const CONTRAST = 0.88;
const SATURATION = 0.55;

// hue-rotate(180deg), from the Filter Effects spec with cos = -1, sin = 0.
const HUE = [
  [-0.574, 1.43, 0.144],
  [0.426, 0.43, 0.144],
  [0.426, 1.43, -0.856],
] as const;

// saturate(s), from the same spec.
const s = SATURATION;
const SAT = [
  [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
  [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
  [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
] as const;

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function apply(m: readonly (readonly number[])[], r: number, g: number, b: number): [number, number, number] {
  return [
    clamp(m[0]![0]! * r + m[0]![1]! * g + m[0]![2]! * b),
    clamp(m[1]![0]! * r + m[1]![1]! * g + m[1]![2]! * b),
    clamp(m[2]![0]! * r + m[2]![1]! * g + m[2]![2]! * b),
  ];
}

/** Recolours RGBA pixels in place, alpha untouched. */
export function darkenPixels(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    let r = 1 - data[i]! / 255;
    let g = 1 - data[i + 1]! / 255;
    let b = 1 - data[i + 2]! / 255;
    [r, g, b] = apply(HUE, r, g, b);
    r = clamp(r * BRIGHTNESS);
    g = clamp(g * BRIGHTNESS);
    b = clamp(b * BRIGHTNESS);
    r = clamp((r - 0.5) * CONTRAST + 0.5);
    g = clamp((g - 0.5) * CONTRAST + 0.5);
    b = clamp((b - 0.5) * CONTRAST + 0.5);
    [r, g, b] = apply(SAT, r, g, b);
    data[i] = r * 255;
    data[i + 1] = g * 255;
    data[i + 2] = b * 255;
  }
}
