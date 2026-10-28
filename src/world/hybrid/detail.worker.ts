import { buildDirect } from './strategies/DirectSurfaceStrategy';
import type { Cluster } from './surface';
import { packGeometry, transferBuffers } from './GeometryTransfer';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: string; cluster: Cluster }>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};
scope.onmessage = ({ data }) => {
  const result = packGeometry(buildDirect(data.cluster));
  scope.postMessage({ id: data.id, result }, transferBuffers(result));
};
