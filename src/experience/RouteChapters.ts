/**
 * Narrative labels for the train's progress along the portal loop.
 * Progress 0 starts deep inside the west tunnel.
 */

const CHAPTERS = [
  { at: 0, label: 'Tunel Zachodni — portal' },
  { at: 0.05, label: 'Przedmieścia' },
  { at: 0.16, label: 'Stacja Zachodnia' },
  { at: 0.3, label: 'Dzielnica mieszkalna' },
  { at: 0.47, label: 'Wjazd na wiadukt' },
  { at: 0.58, label: 'Przystanek Wiadukt' },
  { at: 0.72, label: 'Zjazd ze wzgórza' },
  { at: 0.85, label: 'Wschodnie peryferie' },
  { at: 0.93, label: 'Tunel Wschodni — portal' },
];

export function chapterForProgress(progress: number): string {
  const normalizedProgress = ((progress % 1) + 1) % 1;
  let chapter = CHAPTERS[0].label;

  for (const candidate of CHAPTERS) {
    if (normalizedProgress >= candidate.at) chapter = candidate.label;
  }

  return chapter;
}
