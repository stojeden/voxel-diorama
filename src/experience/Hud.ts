import type { UiHandle } from '../ui';
import type { EclipseTimelineState } from './EclipseTimeline';
import type { WallClock01 } from '../units';

const ECLIPSE_PHASE_LABELS: Record<EclipseTimelineState['phase'], string> = {
  'partial-in': 'FAZA CZĘŚCIOWA · C1 → C2',
  'c2-diamond-ring': 'C2 · DIAMENTOWY PIERŚCIEŃ',
  totality: 'TOTALNOŚĆ · KORONA SŁONECZNA',
  'c3-diamond-ring': 'C3 · DIAMENTOWY PIERŚCIEŃ',
  'partial-out': 'FAZA CZĘŚCIOWA · C3 → C4',
  complete: 'C4 · KONIEC ZAĆMIENIA',
};

/** An hour, so it takes the **wall** clock: 0.75 here is 18:00 and never "sunset". */
export function formatClock(t01: WallClock01): string {
  const hours = Math.floor(t01 * 24);
  const minutes = Math.floor((t01 * 24 * 60) % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function updateEclipseHud(ui: UiHandle, state: EclipseTimelineState, active: boolean): void {
  if (!active) {
    ui.setEclipseStatus(false);
    return;
  }
  const coverage = Math.round(state.coverage * 100);
  const safety = state.phase === 'totality'
    ? 'KORONA WIDOCZNA · CZAS SYMULACJI SKOMPRESOWANY'
    : `POKRYCIE ${coverage}% · UŻYWAJ FILTRA SŁONECZNEGO`;
  ui.setEclipseStatus(true, ECLIPSE_PHASE_LABELS[state.phase], safety, state.progress);
}
