/**
 * The node kinds' glyphs, as SVG markup on a 24-unit square, stroked at 1.75.
 * `Icons.tsx` draws them in the page; `noticeAvatar.ts` draws a
 * notification's circle from the same markup on a canvas.
 */

export const REPEATER_GLYPH = '<path d="M12 21V9"/><path d="M8 9h8l-1-5H9z"/><path d="M6 14a8 8 0 0 1 0-6M18 14a8 8 0 0 0 0-6"/>';
export const ROOM_GLYPH = '<path d="M4 20V8l8-5 8 5v12z"/><path d="M10 20v-6h4v6"/>';
export const SENSOR_GLYPH = '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>';
