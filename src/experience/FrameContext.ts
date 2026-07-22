export interface FrameContext {
  frameIndex: number;
  timestampMs: number;
  realDelta: number;
  simulationDelta: number;
  elapsedSimulation: number;
}

/** One mutable object is reused by the RAF loop; no per-frame allocation. */
export function createFrameContext(): FrameContext {
  return {
    frameIndex: 0,
    timestampMs: 0,
    realDelta: 0,
    simulationDelta: 0,
    elapsedSimulation: 0,
  };
}
