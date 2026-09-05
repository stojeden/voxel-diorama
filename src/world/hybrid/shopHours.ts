/**
 * When the neighbourhood grocery has its lights on.
 *
 * Six in the morning to eleven at night: a grocery's hours, not the tenement shops'
 * ten-to-six, which is why this is its own function and its own palette entry. Like
 * everything else about an hour in this city it reads `clockT` -- the real hour of the day,
 * the one the HUD prints -- and never `t01`, which real-time mode warps onto the viewer's
 * own sunrise and sunset.
 *
 * The light is a state, not an animation: there is nothing to ease, so there is nothing to
 * get out of step after a checkpoint or a jump in the clock.
 */

/** Six in the morning. */
export const GROCERY_OPEN_HOUR = 6;
/** Eleven at night. */
export const GROCERY_CLOSE_HOUR = 23;
/** Emissive strength of the display glass with the lights on, after dark. */
export const GROCERY_GLOW_NIGHT = 0.95;
/** And in daylight, when a lit shop window is a hint rather than a lamp. */
export const GROCERY_GLOW_DAY = 0.16;

/** Is the grocery open at this hour of the day? */
export function isGroceryOpen(clockT: number): boolean {
  const hour = (((clockT % 1) + 1) % 1) * 24;
  return hour >= GROCERY_OPEN_HOUR - 1e-9 && hour < GROCERY_CLOSE_HOUR - 1e-9;
}

/** Emissive strength for the grocery's display glass. Zero when it is shut. */
export function groceryGlow(clockT: number, night: number): number {
  if (!isGroceryOpen(clockT)) return 0;
  return GROCERY_GLOW_DAY + (GROCERY_GLOW_NIGHT - GROCERY_GLOW_DAY) * Math.min(1, Math.max(0, night));
}
