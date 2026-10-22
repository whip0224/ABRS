import rawJson from "./snapshot.json"
import { prepare, type Network, type RawSnapshot } from "./engine"

let cached: Network | null = null

export function getRawSnapshot(): RawSnapshot {
  return rawJson as unknown as RawSnapshot
}

export function getNetwork(): Network {
  if (!cached) cached = prepare(getRawSnapshot())
  return cached
}
