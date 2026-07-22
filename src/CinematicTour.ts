export type TourChapterId =
  | 'train'
  | 'bus'
  | 'lake'
  | 'residents'
  | 'golden-hour'
  | 'totality'
  | 'cyberpunk';

export type TourCameraRig = TourChapterId;

export interface TourChapter {
  readonly id: TourChapterId;
  readonly label: string;
  readonly duration: number;
  readonly cameraRig: TourCameraRig;
  readonly dayProgress: number;
  readonly weather: 'clear';
  readonly theme: 'classic' | 'cyberpunk';
  readonly eclipseProgress: number | null;
  readonly trainProgress?: number;
  readonly busProgress?: number;
}

export interface TourFrame {
  readonly chapter: TourChapter;
  readonly chapterIndex: number;
  readonly localProgress: number;
  readonly entered: boolean;
}

export const TOUR_CHAPTERS: readonly TourChapter[] = [
  { id: 'train', label: 'POCIĄG', duration: 5, cameraRig: 'train', dayProgress: 0.42, weather: 'clear', theme: 'classic', eclipseProgress: null, trainProgress: 0.68 },
  { id: 'bus', label: 'AUTOBUS', duration: 4.5, cameraRig: 'bus', dayProgress: 0.46, weather: 'clear', theme: 'classic', eclipseProgress: null, busProgress: 0.25 },
  { id: 'lake', label: 'JEZIORO', duration: 5, cameraRig: 'lake', dayProgress: 0.52, weather: 'clear', theme: 'classic', eclipseProgress: null },
  { id: 'residents', label: 'MIESZKAŃCY', duration: 5, cameraRig: 'residents', dayProgress: 0.48, weather: 'clear', theme: 'classic', eclipseProgress: null },
  { id: 'golden-hour', label: 'GOLDEN HOUR', duration: 5, cameraRig: 'golden-hour', dayProgress: 0.28, weather: 'clear', theme: 'classic', eclipseProgress: null },
  { id: 'totality', label: 'TOTALNOŚĆ', duration: 6, cameraRig: 'totality', dayProgress: 0.715, weather: 'clear', theme: 'classic', eclipseProgress: 0.5 },
  { id: 'cyberpunk', label: 'CYBERPUNK', duration: 7, cameraRig: 'cyberpunk', dayProgress: 0.86, weather: 'clear', theme: 'cyberpunk', eclipseProgress: null },
] as const;

/** Pure, allocation-free chapter sequencer. Camera and scene side effects live elsewhere. */
export class CinematicTour {
  private active = false;
  private chapterIndex = 0;
  private chapterElapsed = 0;
  private onFinish?: () => void;
  private readonly frame: TourFrame = {
    chapter: TOUR_CHAPTERS[0],
    chapterIndex: 0,
    localProgress: 0,
    entered: false,
  };

  start(onFinish?: () => void): TourFrame {
    this.active = true;
    this.chapterIndex = 0;
    this.chapterElapsed = 0;
    this.onFinish = onFinish;
    return this.writeFrame(true);
  }

  stop(): void {
    this.active = false;
    this.onFinish = undefined;
  }

  isActive(): boolean {
    return this.active;
  }

  getCurrentFrame(): TourFrame | null {
    return this.active ? this.frame : null;
  }

  update(delta: number): TourFrame | null {
    if (!this.active) return null;
    let entered = false;
    this.chapterElapsed += Math.max(0, delta);
    while (this.chapterElapsed >= TOUR_CHAPTERS[this.chapterIndex].duration) {
      this.chapterElapsed -= TOUR_CHAPTERS[this.chapterIndex].duration;
      this.chapterIndex++;
      if (this.chapterIndex >= TOUR_CHAPTERS.length) {
        const finish = this.onFinish;
        this.stop();
        finish?.();
        return null;
      }
      entered = true;
    }
    return this.writeFrame(entered);
  }

  seek(id: TourChapterId, localProgress = 0): TourFrame {
    const index = TOUR_CHAPTERS.findIndex((chapter) => chapter.id === id);
    if (index < 0) throw new Error(`Unknown tour chapter: ${id}`);
    this.active = true;
    this.chapterIndex = index;
    this.chapterElapsed = TOUR_CHAPTERS[index].duration * Math.min(1, Math.max(0, localProgress));
    return this.writeFrame(true);
  }

  static getDuration(): number {
    return TOUR_CHAPTERS.reduce((total, chapter) => total + chapter.duration, 0);
  }

  private writeFrame(entered: boolean): TourFrame {
    const mutable = this.frame as {
      chapter: TourChapter;
      chapterIndex: number;
      localProgress: number;
      entered: boolean;
    };
    const chapter = TOUR_CHAPTERS[this.chapterIndex];
    mutable.chapter = chapter;
    mutable.chapterIndex = this.chapterIndex;
    mutable.localProgress = Math.min(1, this.chapterElapsed / chapter.duration);
    mutable.entered = entered;
    return this.frame;
  }
}
