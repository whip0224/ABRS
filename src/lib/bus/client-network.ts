import { networkSnapshot, refreshNetwork } from "./api"
import { prepare, type Network, type RawSnapshot } from "./engine"

const DB = "touhou-network"
const STORE = "snapshot"

type Loose = {
  no: string
  co: string[]
  orig: string
  dest: string
  serviceType: string
  dir: string
  stopCo: string
  nlbId: string | null
  gtfsId: string | null
  jt: number | null
  stopIds: string[]
}

const PARTS = [
  { part: "kmb", label: "九巴", shards: 1, min: 1400, companies: ["kmb"] },
  { part: "ctb", label: "城巴", shards: 6, min: 600, companies: ["ctb"] },
  { part: "nlb", label: "嶼巴", shards: 1, min: 40, companies: ["nlb"] },
  { part: "gmb", label: "小巴", shards: 8, min: 700, companies: ["gmb"] },
  { part: "mtr", label: "港鐵巴士", shards: 1, min: 30, companies: ["lrtfeeder"] },
] as const

let memory: Network | null = null
let rawMemory: RawSnapshot | null = null
let loading: Promise<Network> | null = null

export function loadedNetwork() {
  return memory
}

export function ensureNetwork() {
  if (memory) return Promise.resolve(memory)
  if (!loading) {
    loading = restore().finally(() => {
      loading = null
    })
  }
  return loading
}

export async function updateNetwork(onPart?: (message: string) => void) {
  if (!rawMemory) await ensureNetwork()
  const prev = rawMemory
  if (!prev) throw new Error("路線資料尚未下載")
  let current = prev.routes.map((route) => toLoose(prev, route))
  const stops = new Map(prev.stops.map((row) => [row[0], row]))
  const updated: string[] = []
  const kept: string[] = []
  for (const plan of PARTS) {
    try {
      const fresh: Loose[] = []
      for (let shard = 0; shard < plan.shards; shard++) {
        onPart?.(
          plan.shards > 1
            ? `正在更新${plan.label}路線（${shard + 1}/${plan.shards}）…`
            : `正在更新${plan.label}路線…`,
        )
        const chunk = await refreshNetwork({ data: { part: plan.part, shard, shards: plan.shards } })
        for (const row of chunk.stops) stops.set(row[0], row)
        for (const route of chunk.routes) fresh.push(toLoose(chunk, route))
      }
      if (fresh.length < plan.min) throw new Error("這部分路線更新未完整，仍用手機裡的資料。")
      current = current.filter((route) => !involves(route, plan.companies))
      current.push(...fresh)
      updated.push(plan.label)
    } catch {
      kept.push(plan.label)
    }
  }
  if (updated.length === 0) throw new Error("暫時連不上巴士公司，仍用手機裡的路線資料。")
  const raw = packSnapshot(mergeJointLoose(current), stops)
  assertSnapshot(raw)
  await writeSnapshot(raw)
  rawMemory = raw
  memory = prepare(raw)
  return { built: raw.built, updated, kept }
}

async function restore() {
  const cached = await readSnapshot()
  if (cached) {
    try {
      rawMemory = cached
      memory = prepare(cached)
      return memory
    } catch {
      await clearSnapshot()
    }
  }
  const raw = await networkSnapshot()
  assertSnapshot(raw)
  await writeSnapshot(raw)
  rawMemory = raw
  memory = prepare(raw)
  return memory
}

function toLoose(raw: RawSnapshot, route: RawSnapshot["routes"][number]): Loose {
  return {
    no: route[0],
    co: route[1],
    orig: route[2],
    dest: route[3],
    serviceType: route[4],
    dir: route[5],
    stopCo: route[6],
    nlbId: route[7],
    gtfsId: route[8],
    jt: route[9],
    stopIds: route[10].map((at) => raw.stops[at][0]),
  }
}

function involves(route: Loose, companies: readonly string[]) {
  return companies.includes(route.stopCo) || route.co.some((co) => companies.includes(co))
}

function mergeJointLoose(routes: Loose[]) {
  const seen = new Map<string, Loose>()
  const out: Loose[] = []
  for (const route of routes) {
    const co = route.co[0]
    if (co !== "kmb" && co !== "ctb") {
      out.push(route)
      continue
    }
    const key = `${route.no}|${route.dir}|${route.serviceType}`
    const other = seen.get(key)
    if (!other) {
      seen.set(key, route)
      out.push(route)
      continue
    }
    if (other.co[0] === co) continue
    other.co = ["kmb", "ctb"]
    if (route.stopIds.length > other.stopIds.length) {
      other.orig = route.orig
      other.dest = route.dest
      other.stopCo = route.stopCo
      other.stopIds = route.stopIds
    }
  }
  return out
}

function packSnapshot(routes: Loose[], stopMap: Map<string, RawSnapshot["stops"][number]>) {
  const stops: RawSnapshot["stops"] = []
  const index = new Map<string, number>()
  const packed: RawSnapshot["routes"] = []
  for (const route of routes) {
    const ids: number[] = []
    for (const id of route.stopIds) {
      const known = index.get(id)
      if (known !== undefined) {
        ids.push(known)
        continue
      }
      const row = stopMap.get(id)
      if (!row) continue
      const at = stops.length
      stops.push(row)
      index.set(id, at)
      ids.push(at)
    }
    if (ids.length < 2 || !route.no) continue
    packed.push([
      route.no,
      route.co,
      route.orig,
      route.dest,
      route.serviceType,
      route.dir,
      route.stopCo,
      route.nlbId,
      route.gtfsId,
      route.jt,
      ids,
    ])
  }
  return { built: new Date().toISOString().slice(0, 10), stops, routes: packed }
}

function assertSnapshot(raw: RawSnapshot, minRoutes = 1000) {
  if (!raw || !Array.isArray(raw.stops) || !Array.isArray(raw.routes) || raw.routes.length < minRoutes) {
    throw new Error("路線資料不完整")
  }
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("無法儲存路線資料"))
  })
}

async function readSnapshot() {
  if (typeof indexedDB === "undefined") return null
  const db = await openDb()
  return new Promise<RawSnapshot | null>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get("current")
    request.onsuccess = () => resolve((request.result as RawSnapshot | undefined) ?? null)
    request.onerror = () => reject(request.error ?? new Error("無法讀取路線資料"))
  })
}

async function writeSnapshot(raw: RawSnapshot) {
  if (typeof indexedDB === "undefined") return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(raw, "current")
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error("無法儲存路線資料"))
  })
}

async function clearSnapshot() {
  if (typeof indexedDB === "undefined") return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete("current")
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error("無法清除路線資料"))
  })
}
