/**
 * "Co dzieje się teraz" — a projection over world state that is already owned
 * elsewhere. It invents no events, predicts nothing from elapsed time and holds
 * no simulation state of its own: every field of the snapshot is read from the
 * system that already owns that truth.
 */

export type AmbientEventKind = 'eclipse' | 'tour' | 'rainbow' | 'train-stop' | 'bus-stop';

/** Automatic framing currently owned by `CameraDirector`. */
export type AmbientCameraAutomation = 'overview' | 'eclipse' | 'tour' | 'train' | 'bus' | null;

/**
 * Flat and reusable on purpose: the caller keeps one instance and rewrites its
 * fields, so the projection allocates nothing per update.
 */
export interface AmbientWorldSnapshot {
  /** True while the eclipse timeline is genuinely mid-event. */
  eclipseActive: boolean;
  /** Chapter label, non-null only while a tour the user asked for is running. */
  tourChapterLabel: string | null;
  /** Observer-relative rainbow visibility — the same predicate the renderer uses. */
  rainbowVisible: boolean;
  /** Moisture-curtain id behind the visible arc. */
  rainbowZone: string;
  /** Station label while the train holds at a platform, otherwise null. */
  trainStopLabel: string | null;
  trainStopSecondsLeft: number;
  /** Stop label while the bus holds at a shelter, otherwise null. */
  busStopLabel: string | null;
  cameraAutomation: AmbientCameraAutomation;
}

export interface AmbientEvent {
  readonly kind: AmbientEventKind;
  readonly title: string;
  /** May be empty — the eclipse HUD already owns phase, coverage and progress. */
  readonly detail: string;
  /** Whether an explicit user click can hand this event to `CameraDirector`. */
  readonly canFrame: boolean;
}

/** Highest priority first. At most one entry is ever reported. */
export const AMBIENT_PRIORITY: readonly AmbientEventKind[] = [
  'eclipse',
  'tour',
  'rainbow',
  'train-stop',
  'bus-stop',
];

/**
 * Anti-flicker window for the *kind* of event on display. Text inside one kind
 * keeps updating freely, and an event that actually ends is dropped at once —
 * a minimum exposure must never outlive the thing it describes.
 */
export const AMBIENT_MIN_EXPOSURE_SECONDS = 2.5;

const TITLES: Readonly<Record<AmbientEventKind, string>> = {
  eclipse: 'ZAĆMIENIE SŁOŃCA',
  tour: 'TOUR',
  rainbow: 'TĘCZA PO DESZCZU',
  'train-stop': 'POSTÓJ POCIĄGU',
  'bus-stop': 'POSTÓJ AUTOBUSU',
};

const RAINBOW_ZONE_LABELS: Readonly<Record<string, string>> = {
  lake: 'nad jeziorem',
  'lakeside-meadow': 'nad łąką',
  'north-park': 'nad parkiem',
};

function isActive(kind: AmbientEventKind, world: AmbientWorldSnapshot): boolean {
  switch (kind) {
    case 'eclipse':
      return world.eclipseActive;
    case 'tour':
      return world.tourChapterLabel !== null;
    case 'rainbow':
      return world.rainbowVisible;
    case 'train-stop':
      return world.trainStopLabel !== null;
    case 'bus-stop':
      return world.busStopLabel !== null;
  }
}

/**
 * A tour shot is already the camera's own choreography, and re-framing what the
 * camera is following is a no-op, so neither offers an action.
 */
export function canFrameEvent(
  kind: AmbientEventKind,
  automation: AmbientCameraAutomation
): boolean {
  if (kind === 'tour' || automation === 'tour') return false;
  if (kind === 'train-stop') return automation !== 'train';
  if (kind === 'bus-stop') return automation !== 'bus';
  if (kind === 'eclipse') return automation !== 'eclipse';
  return true;
}

/**
 * Reports events the world *entered*, the way `TourFrame.entered` does. State
 * that was already true when the projection first ran is an initial condition,
 * not something that is happening, so the diorama opens with an empty status
 * instead of a welcome nudge.
 */
export class AmbientEventProjection {
  private current: AmbientEventKind | null = null;
  private currentSince = 0;
  private readonly entered: Record<AmbientEventKind, boolean> = {
    eclipse: false,
    tour: false,
    rainbow: false,
    'train-stop': false,
    'bus-stop': false,
  };
  private readonly event: { -readonly [K in keyof AmbientEvent]: AmbientEvent[K] } = {
    kind: 'eclipse',
    title: '',
    detail: '',
    canFrame: false,
  };

  /** @returns the single reported event, or null when nothing notable is happening. */
  select(world: AmbientWorldSnapshot, nowSeconds: number): AmbientEvent | null {
    let winner: AmbientEventKind | null = null;
    for (const kind of AMBIENT_PRIORITY) {
      const active = isActive(kind, world);
      // An event has to be absent once before it can be reported as entered.
      if (!active) this.entered[kind] = true;
      else if (this.entered[kind] && winner === null) winner = kind;
    }

    // Hold the current kind briefly so simultaneous events cannot flicker, but
    // only while it is still genuinely happening.
    const current = this.current;
    if (
      current !== null &&
      this.isReportable(current, world) &&
      nowSeconds - this.currentSince < AMBIENT_MIN_EXPOSURE_SECONDS
    ) {
      return this.write(current, world);
    }

    if (winner === null) {
      this.current = null;
      return null;
    }
    if (winner !== this.current) {
      this.current = winner;
      this.currentSince = nowSeconds;
    }
    return this.write(winner, world);
  }

  /** Introspection for diagnostics: which kinds have been seen absent, and what is on screen. */
  getDebugState(): { current: AmbientEventKind | null; entered: Record<AmbientEventKind, boolean> } {
    return { current: this.current, entered: { ...this.entered } };
  }

  private isReportable(kind: AmbientEventKind, world: AmbientWorldSnapshot): boolean {
    return this.entered[kind] && isActive(kind, world);
  }

  private write(kind: AmbientEventKind, world: AmbientWorldSnapshot): AmbientEvent {
    const event = this.event;
    event.kind = kind;
    event.title = TITLES[kind];
    event.detail = detailFor(kind, world);
    event.canFrame = canFrameEvent(kind, world.cameraAutomation);
    return event;
  }
}

/** The eclipse stays detail-free: its own HUD owns phase, coverage and progress. */
function detailFor(kind: AmbientEventKind, world: AmbientWorldSnapshot): string {
  if (kind === 'tour') return world.tourChapterLabel ?? '';
  if (kind === 'rainbow') return RAINBOW_ZONE_LABELS[world.rainbowZone] ?? '';
  if (kind === 'bus-stop') return world.busStopLabel ?? '';
  if (kind !== 'train-stop' || world.trainStopLabel === null) return '';
  const label = world.trainStopLabel;
  return world.trainStopSecondsLeft > 0.4
    ? `${label} · ${Math.ceil(world.trainStopSecondsLeft)} s`
    : label;
}
