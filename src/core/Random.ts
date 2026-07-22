export const DEFAULT_SIMULATION_SEED = 20260722;

export type RandomSource = () => number;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WorldRandom {
  readonly seed: number;
  stream: (scope: string) => RandomSource;
  sample: (scope: string, index: number) => number;
}

export function normalizeSeed(value: string | number | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric >>> 0 : hashString(value.trim());
  }
  return DEFAULT_SIMULATION_SEED;
}

export function createWorldRandom(seedInput: string | number = DEFAULT_SIMULATION_SEED): WorldRandom {
  const seed = normalizeSeed(seedInput);
  const seedFor = (scope: string) => hashString(`${seed}:${scope}`);
  return {
    seed,
    stream: (scope) => mulberry32(seedFor(scope)),
    sample: (scope, index) => mulberry32(seedFor(`${scope}:${index}`))(),
  };
}

/** Deterministic fallback for isolated module tests; production passes a named world stream. */
export function fallbackRandom(scope: string): RandomSource {
  return createWorldRandom().stream(scope);
}
