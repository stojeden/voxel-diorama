import { describe, expect, test } from 'vitest';
import { createFrameTiming, type GlSource } from './frameTiming';

/**
 * The GPU probe's query lifecycle, driven by a fake WebGL2 context so the whole thing
 * runs without a GPU.
 *
 * Every case ends by checking that as many queries were deleted as were created: a
 * timer query is a GL object, and a diagnostic that leaks one per frame is worse than
 * no diagnostic. The last test runs the pre-fix algorithm against the same fake context
 * and shows the two faults it had -- results from an old series landing in a new one,
 * and queries abandoned for age never being deleted.
 */

interface FakeQuery {
  id: number;
  target: number | null;
  /** Nanoseconds this query will report once available. */
  result: number;
  availableAfter: number;
  deleted: boolean;
}

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
const QUERY_RESULT_AVAILABLE = 0x9194;
const QUERY_RESULT = 0x8866;

/**
 * A WebGL2 context with just enough behaviour to exercise the probe: it counts
 * created and deleted queries, refuses a nested begin on the same target, and hands
 * out results only once the caller has advanced its own clock past `availableAfter`.
 */
function fakeGl(options: { extension?: boolean; resultNs?: number; latency?: number } = {}) {
  const { extension = true, latency = 1 } = options;
  let resultNs = options.resultNs ?? 4_000_000;
  const queries: FakeQuery[] = [];
  let nextId = 1;
  let clock = 0;
  let activeTarget: number | null = null;
  let disjoint = 0;
  const errors: string[] = [];

  const gl = {
    QUERY_RESULT_AVAILABLE,
    QUERY_RESULT,
    createQuery(): FakeQuery {
      const query: FakeQuery = {
        id: nextId++,
        target: null,
        result: resultNs,
        availableAfter: Number.POSITIVE_INFINITY,
        deleted: false,
      };
      queries.push(query);
      return query;
    },
    deleteQuery(query: FakeQuery): void {
      if (query.deleted) errors.push(`query ${query.id} deleted twice`);
      if (query.target !== null) errors.push(`query ${query.id} deleted while recording`);
      query.deleted = true;
    },
    beginQuery(target: number, query: FakeQuery): void {
      if (activeTarget === target) errors.push(`nested beginQuery on target ${target}`);
      activeTarget = target;
      query.target = target;
    },
    endQuery(target: number): void {
      if (activeTarget !== target) {
        errors.push(`endQuery without a matching beginQuery on target ${target}`);
        return;
      }
      activeTarget = null;
      const open = queries.find((candidate) => candidate.target === target);
      if (open) {
        open.target = null;
        open.availableAfter = clock + latency;
      }
    },
    getExtension(name: string) {
      if (!extension || name !== 'EXT_disjoint_timer_query_webgl2') return null;
      return { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT };
    },
    getParameter(parameter: number): number {
      return parameter === GPU_DISJOINT_EXT ? disjoint : 0;
    },
    getQueryParameter(query: FakeQuery, parameter: number): number | boolean {
      if (parameter === QUERY_RESULT_AVAILABLE) return clock >= query.availableAfter && !query.deleted;
      return query.result;
    },
  };

  return {
    source: { getContext: () => gl } satisfies GlSource,
    gl,
    /** Advance the fake GPU's clock, which is what makes results available. */
    tick: (by = 1) => { clock += by; },
    /** Change what queries created from now on will report, to tell series apart. */
    setResult: (ns: number) => { resultNs = ns; },
    setDisjoint: (value: boolean) => { disjoint = value ? 1 : 0; },
    stats: () => ({
      created: queries.length,
      deleted: queries.filter((query) => query.deleted).length,
      leaked: queries.filter((query) => !query.deleted).length,
      recording: queries.filter((query) => query.target !== null).length,
      results: queries.map((query) => query.result),
    }),
    errors,
    queries,
  };
}

/** Render `count` frames through the probe, advancing the fake GPU each time. */
function renderFrames(
  timing: ReturnType<typeof createFrameTiming>,
  fake: ReturnType<typeof fakeGl>,
  count: number
): void {
  for (let i = 0; i < count; i++) {
    const token = timing.begin();
    timing.end(token);
    fake.tick();
  }
}

describe('GPU frame timing probe', () => {
  test('a complete series returns exactly what was asked for, and leaks nothing', () => {
    const fake = fakeGl({ resultNs: 5_500_000 });
    const timing = createFrameTiming(fake.source);
    expect(timing.read().status).toBe('idle');

    const id = timing.start(4);
    expect(id).toBe(1);
    expect(timing.read().status).toBe('measuring');

    renderFrames(timing, fake, 20);
    const reading = timing.read();
    expect(reading.status).toBe('complete');
    expect(reading.usable).toBe(true);
    expect(reading.series).toBe(1);
    expect(reading.samples).toHaveLength(4);
    for (const sample of reading.samples) expect(sample).toBeCloseTo(5.5, 6);
    expect(reading.pending).toBe(0);
    expect(reading.dropped).toBe(0);
    expect(fake.stats().leaked).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  test('a series that never resolves times out and releases its queries', () => {
    const fake = fakeGl({ latency: Number.POSITIVE_INFINITY });
    const timing = createFrameTiming(fake.source);
    timing.start(90, 30);

    renderFrames(timing, fake, 40);
    const reading = timing.read();
    expect(reading.status).toBe('timeout');
    expect(reading.usable).toBe(false);
    expect(reading.samples.length).toBeLessThan(90);
    expect(reading.pending).toBe(0);
    expect(fake.stats().leaked, 'a timed-out series must not leak queries').toBe(0);
    expect(fake.errors).toEqual([]);
  });

  test('a reset with results still in flight cannot feed the next series', () => {
    // Series 1 asks for a lot and is abandoned with its queries unresolved. Their
    // results then become available -- and must go nowhere.
    const fake = fakeGl({ latency: 6, resultNs: 99_000_000 });
    const timing = createFrameTiming(fake.source);
    timing.start(50);
    renderFrames(timing, fake, 3);
    expect(timing.read().pending).toBeGreaterThan(0);
    const inFlight = timing.read().pending;

    timing.cancel();
    expect(timing.read().status).toBe('cancelled');
    expect(timing.read().pending).toBe(0);
    expect(fake.stats().leaked, 'cancelling must delete the queries it owned').toBe(0);

    // The old results are now available; the new series must not contain 99 ms samples.
    fake.tick(10);
    fake.setResult(4_000_000);
    timing.start(3);
    expect(timing.read().series).toBe(2);
    renderFrames(timing, fake, 20);
    const reading = timing.read();
    expect(reading.status).toBe('complete');
    expect(reading.series).toBe(2);
    expect(reading.samples).toHaveLength(3);
    // Series 1 reports 99 ms and series 2 reports 4 ms, so a mixed sample is visible.
    for (const sample of reading.samples) expect(sample, `series 2 sample ${sample}`).toBeCloseTo(4, 6);
    expect(reading.samples.some((sample) => Math.abs(sample - 99) < 1)).toBe(false);
    expect(fake.stats().leaked).toBe(0);
    expect(fake.errors).toEqual([]);
    expect(inFlight).toBeGreaterThan(0);
  });

  test('two series in a row keep their own identity and samples', () => {
    const fake = fakeGl({ resultNs: 2_000_000 });
    const timing = createFrameTiming(fake.source);
    timing.start(3);
    renderFrames(timing, fake, 12);
    const first = timing.read();
    expect(first.status).toBe('complete');
    expect(first.series).toBe(1);
    expect(first.samples).toHaveLength(3);

    // A second series may only begin once the first is closed, which it is.
    timing.start(5);
    const opened = timing.read();
    expect(opened.series).toBe(2);
    expect(opened.samples).toEqual([]);
    expect(opened.requested).toBe(5);
    renderFrames(timing, fake, 15);
    const second = timing.read();
    expect(second.status).toBe('complete');
    expect(second.series).toBe(2);
    expect(second.samples).toHaveLength(5);
    expect(fake.stats().leaked).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  test('an open series refuses to be replaced, and says so', () => {
    const fake = fakeGl({ latency: 4 });
    const timing = createFrameTiming(fake.source);
    timing.start(20);
    renderFrames(timing, fake, 2);
    expect(() => timing.start(20)).toThrow(/still measuring/);
    timing.cancel();
    expect(() => timing.start(20)).not.toThrow();
    timing.cancel();
    expect(fake.stats().leaked).toBe(0);
  });

  test('a disjoint interval voids the series instead of being averaged into it', () => {
    const fake = fakeGl();
    const timing = createFrameTiming(fake.source);
    timing.start(6);
    renderFrames(timing, fake, 4);
    expect(timing.read().status).toBe('measuring');

    fake.setDisjoint(true);
    renderFrames(timing, fake, 2);
    const reading = timing.read();
    expect(reading.status).toBe('disjoint');
    expect(reading.disjoint).toBe(true);
    expect(reading.usable, 'a disjoint series must never be quoted').toBe(false);
    expect(reading.pending).toBe(0);
    expect(fake.stats().leaked).toBe(0);
    expect(fake.errors).toEqual([]);
  });

  test('a context without the timer extension reports unsupported and creates nothing', () => {
    const fake = fakeGl({ extension: false });
    const timing = createFrameTiming(fake.source);
    timing.start(30);
    const opened = timing.read();
    expect(opened.status).toBe('unsupported');
    expect(opened.usable).toBe(false);

    renderFrames(timing, fake, 10);
    const reading = timing.read();
    expect(reading.status).toBe('unsupported');
    expect(reading.samples).toEqual([]);
    expect(fake.stats().created, 'nothing to create without the extension').toBe(0);
    expect(fake.errors).toEqual([]);
  });

  test('90 requested samples are not complete on five', () => {
    // The rule the benchmark used to apply -- "five samples is enough to quote" -- has
    // no expression here: a series of 90 that collected 8 is a timeout, not a result.
    const fake = fakeGl({ latency: 2 });
    const timing = createFrameTiming(fake.source);
    timing.start(90, 12);
    renderFrames(timing, fake, 14);
    const reading = timing.read();
    expect(reading.requested).toBe(90);
    expect(reading.samples.length).toBeGreaterThan(4);
    expect(reading.samples.length).toBeLessThan(90);
    expect(reading.status).toBe('timeout');
    expect(reading.usable).toBe(false);
  });

  test('negative control: the pre-fix algorithm mixes series and leaks queries', () => {
    /**
     * The implementation this file replaced, in behaviour: `start()` cleared samples,
     * the disjoint flag and the wanted count but kept `pending`, and a query abandoned
     * for age was dropped from the array without `deleteQuery`.
     */
    const legacy = (source: GlSource) => {
      let want = 0;
      let pending: { query: FakeQuery; frame: number }[] = [];
      let samples: number[] = [];
      let counter = 0;
      const ctx = () => {
        const gl = source.getContext() as ReturnType<typeof fakeGl>['gl'];
        return { gl, timer: gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } };
      };
      return {
        begin(): FakeQuery | null {
          if (want <= 0) return null;
          const { gl, timer } = ctx();
          const query = gl.createQuery();
          gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
          return query;
        },
        end(query: FakeQuery | null): void {
          if (!query) return;
          const { gl, timer } = ctx();
          gl.endQuery(timer.TIME_ELAPSED_EXT);
          counter++;
          pending.push({ query, frame: counter });
          pending = pending.filter(({ query: q, frame }) => {
            if (counter - frame < 3) return true;
            if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return counter - frame < 60;
            samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) as number / 1_000_000);
            gl.deleteQuery(q);
            if (samples.length >= want) want = 0;
            return false;
          });
        },
        start(count: number): void { samples = []; want = count; },
        read: () => ({ samples: [...samples], pending: pending.length }),
      };
    };

    // Fault 1: a series started while old queries are pending collects their results.
    const mixing = fakeGl({ latency: 6, resultNs: 99_000_000 });
    const old = legacy(mixing.source);
    old.start(50);
    for (let i = 0; i < 3; i++) { old.end(old.begin()); mixing.tick(); }
    expect(old.read().pending).toBeGreaterThan(0);
    old.start(3); // the "new variant" begins with three queries of the old one still live
    mixing.setResult(4_000_000);
    mixing.tick(10);
    for (let i = 0; i < 6; i++) { old.end(old.begin()); mixing.tick(); }
    const mixed = old.read();
    expect(
      mixed.samples.filter((sample) => Math.abs(sample - 99) < 1e-6).length,
      'the old algorithm feeds the previous series results into the new one'
    ).toBeGreaterThan(0);

    // Fault 2: queries whose results never arrive are dropped without deleteQuery.
    const leaking = fakeGl({ latency: Number.POSITIVE_INFINITY });
    const leaky = legacy(leaking.source);
    leaky.start(90);
    for (let i = 0; i < 70; i++) { leaky.end(leaky.begin()); leaking.tick(); }
    expect(leaking.stats().created).toBe(70);
    expect(
      leaking.stats().leaked,
      'the old algorithm abandons aged-out queries without deleting them'
    ).toBeGreaterThan(0);

    // And the fixed probe on the same path: queries that age out are deleted as they
    // are abandoned, and closing the series leaves nothing behind.
    const fixed = fakeGl({ latency: Number.POSITIVE_INFINITY });
    const timing = createFrameTiming(fixed.source);
    timing.start(90, 200);
    renderFrames(timing, fixed, 70);
    expect(fixed.stats().created).toBe(70);
    expect(timing.read().dropped, 'aged-out queries are counted, not silently dropped').toBeGreaterThan(0);
    expect(fixed.stats().deleted).toBe(timing.read().dropped);
    timing.cancel();
    expect(fixed.stats().leaked).toBe(0);
    expect(fixed.errors).toEqual([]);
  });
});
