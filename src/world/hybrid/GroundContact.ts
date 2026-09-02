import { BUS_ROUTE_CURVE, type BusStop } from '../WorldLayout';
import { groundHeightAt, type CityModel, type Rect } from './CityModel';

/**
 * Ground contact and clearance. Props declare probe points that must rest on the
 * ground within `CONTACT_TOLERANCE`; rectangles must not overlap the forbidden
 * zones (the crosswalk, the dwelling bus). The same rules run as unit tests on the
 * model and, through `checkProbesAgainst`, against the live scene after LOD changes.
 */
export const CONTACT_TOLERANCE = 0.012;
export const BUS_LENGTH = 8;
export const BUS_HALF_WIDTH = 1.15;

export interface ProbeInput {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface Violation {
  id: string;
  kind: 'float' | 'sink' | 'overlap';
  delta?: number;
  against?: string;
}

export interface GroundContactReport {
  ok: boolean;
  checked: number;
  violations: Violation[];
}

export function checkProbes(
  probes: readonly ProbeInput[],
  groundAt: (x: number, z: number) => number,
  tolerance = CONTACT_TOLERANCE
): GroundContactReport {
  const violations: Violation[] = [];
  for (const probe of probes) {
    const delta = probe.y - groundAt(probe.x, probe.z);
    if (delta > tolerance) violations.push({ id: probe.id, kind: 'float', delta });
    else if (delta < -tolerance) violations.push({ id: probe.id, kind: 'sink', delta });
  }
  return { ok: violations.length === 0, checked: probes.length, violations };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

export function checkClearance(id: string, rect: Rect, forbidden: ReadonlyArray<Rect & { id: string }>): Violation[] {
  return forbidden.filter((zone) => rectsOverlap(rect, zone)).map((zone) => ({ id, kind: 'overlap' as const, against: zone.id }));
}

/** Bus body at dwell: the lead point sits on the stop marker; the body extends 8 m behind it. */
export function busDwellEnvelope(stop: BusStop): Rect {
  const lead = BUS_ROUTE_CURVE.getPointAt(stop.atT);
  const tangent = BUS_ROUTE_CURVE.getTangentAt(stop.atT).normalize();
  const tail = lead.clone().addScaledVector(tangent, -BUS_LENGTH);
  const nx = -tangent.z;
  const nz = tangent.x;
  const xs = [lead.x + nx * BUS_HALF_WIDTH, lead.x - nx * BUS_HALF_WIDTH, tail.x + nx * BUS_HALF_WIDTH, tail.x - nx * BUS_HALF_WIDTH];
  const zs = [lead.z + nz * BUS_HALF_WIDTH, lead.z - nz * BUS_HALF_WIDTH, tail.z + nz * BUS_HALF_WIDTH, tail.z - nz * BUS_HALF_WIDTH];
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/** Static checks over the semantic model: probes on the ground, props off the crosswalk, bus off the crosswalk. */
export function checkModel(model: CityModel, stop: BusStop): GroundContactReport {
  const probes: ProbeInput[] = [];
  for (const prop of model.props) {
    prop.probes.forEach((probe, index) => probes.push({ id: `${prop.id}#${index}`, x: probe.x, y: probe.y, z: probe.z }));
  }
  const report = checkProbes(probes, (x, z) => groundHeightAt(model, x, z));
  const crosswalk = { id: 'crosswalk', ...model.crosswalk };
  const bus = { id: 'bus', ...busDwellEnvelope(stop) };
  report.violations.push(...checkClearance('bus', bus, [crosswalk]));
  for (const prop of model.props) report.violations.push(...checkClearance(prop.id, prop.footprint, [crosswalk, bus]));
  report.checked += 1 + model.props.length;
  report.ok = report.violations.length === 0;
  return report;
}
