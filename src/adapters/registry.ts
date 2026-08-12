import { charlotteAdapter } from "./charlotte";
import { leeAdapter } from "./lee";
import { stLucieAdapter } from "./st-lucie";
import type { CountyAdapter, CountyKey } from "./types";

const registry: Record<CountyKey, CountyAdapter> = {
  st_lucie: stLucieAdapter,
  lee: leeAdapter,
  charlotte: charlotteAdapter,
};

export function getAdapter(county: CountyKey): CountyAdapter {
  return registry[county];
}

export function listCounties(): CountyKey[] {
  return Object.keys(registry) as CountyKey[];
}

export function isCountyKey(value: string): value is CountyKey {
  return value in registry;
}
