import type { Cluster } from './surface';
import { buildDirect } from './strategies/DirectSurfaceStrategy';
import { packGeometry, type PackedResult, type PackedGeometry } from './GeometryTransfer';

export const DETAIL_RESIDENT_LIMIT = 48;
export const DETAIL_UPLOAD_BYTES = 2 * 1024 * 1024;
export const DETAIL_UPLOAD_GEOMETRIES = 4;

/** One job/result in flight, no unbounded worker mailbox or completed-result cache. */
export class DetailStreamer {
  private worker: Worker | null = null;
  private active: Cluster | null = null;
  private ready: { id: string; result: PackedResult } | null = null;
  private disposed = false;
  private failed = false;
  private invalidated = false;

  constructor(
    private readonly install: (id: string, geometry: PackedGeometry) => void,
    private readonly complete: (id: string) => void,
  ) {
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('./detail.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<{ id: string; result: PackedResult }>) => {
        if (this.disposed || data.id !== this.active?.id) return;
        this.ready = data;
      };
      this.worker.onerror = () => {
        this.worker?.terminate();
        this.worker = null;
        this.failed = true;
      };
    } catch { this.failed = true; }
  }

  tick(candidates: readonly Cluster[], wanted: ReadonlySet<string>): void {
    if (this.disposed) return;
    // Losing residency is irreversible for this job. Some buffers may already have
    // been uploaded and evicted by the owner; resuming its tail would make an incomplete
    // cluster look resident. An in-flight worker still owns the sole mailbox slot until
    // its reply arrives, but that reply is discarded even if the camera has returned.
    if (this.active && !wanted.has(this.active.id)) this.invalidated = true;
    if (this.invalidated) {
      if (this.ready || !this.worker) {
        this.ready = null;
        this.active = null;
        this.invalidated = false;
      }
      return;
    }
    if (this.ready) {
      const { id, result } = this.ready;
      let bytes = 0;
      let count = 0;
      while (result.geometries.length && count < DETAIL_UPLOAD_GEOMETRIES) {
        const next = result.geometries[0];
        const size = next.attributes.reduce((sum, a) => sum + a.array.byteLength, 0);
        // One indivisible material buffer may exceed the byte target; never starve it.
        if (count > 0 && bytes + size > DETAIL_UPLOAD_BYTES) break;
        result.geometries.shift();
        if (wanted.has(id)) this.install(id, next);
        bytes += size;
        count++;
      }
      if (!result.geometries.length) {
        if (wanted.has(id)) this.complete(id);
        this.ready = null; this.active = null;
      }
      return;
    }
    if (this.active) {
      if (!this.worker) this.ready = { id: this.active.id, result: packGeometry(buildDirect(this.active)) };
      return;
    }
    const next = candidates[0];
    if (!next) return;
    this.active = next;
    if (this.worker) {
      try { this.worker.postMessage({ id: next.id, cluster: next }); }
      catch { this.worker.terminate(); this.worker = null; this.failed = true; }
    }
    // Fallback advances at most one cluster per frame, including after worker failure.
    if (!this.worker) this.ready = { id: next.id, result: packGeometry(buildDirect(next)) };
  }

  get mode(): 'worker' | 'fallback' { return this.worker ? 'worker' : 'fallback'; }
  get pending(): number { return this.active ? 1 : 0; }
  get workerFailed(): boolean { return this.failed; }
  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.active = null;
    this.ready = null;
    this.invalidated = false;
  }
}
