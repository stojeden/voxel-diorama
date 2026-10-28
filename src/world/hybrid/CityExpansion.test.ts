import { expect, it } from 'vitest';
import { buildCityModel } from './CityModel';
import { fourDistrictModel } from './CityExpansion';

it('expands the render workload while retaining original district identities and global events', () => {
  const base = buildCityModel();
  const expanded = fourDistrictModel();
  expect(expanded.buildings).toHaveLength(base.buildings.length * 4);
  expect(new Set(expanded.buildings.map(b => b.index)).size).toBe(expanded.buildings.length);
  expect(expanded.buildings.slice(0, base.buildings.length)).toEqual(base.buildings);
  expect(expanded.dominants).toEqual(base.dominants);
  expect(expanded.props).toEqual(base.props);
  expect(fourDistrictModel()).toEqual(expanded);
});
