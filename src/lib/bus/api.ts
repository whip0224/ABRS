import { createServerFn } from "@tanstack/react-start"
import type { EtaCo, EtaQuery, Point, Suggestion } from "./types"

export const suggestPlaces = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const q = readQuery(input)
    if (q.length < 1) throw new Error("請輸入地名或車站")
    return { q }
  })
  .handler(async ({ data }) => {
    const { getNetwork } = await import("./network.server")
    const { suggestStops } = await import("./engine")
    const places = suggestStops(getNetwork(), data.q)
    const addressy = /[0-9０-９]|號/.test(data.q) || /[道路街巷]/.test(data.q)
    let addresses: Suggestion[] = []
    if (addressy || places.length === 0) {
      const { lookupAddress } = await import("./als.server")
      addresses = await lookupAddress(data.q)
    }
    return { places, addresses }
  })

export const lookupAddresses = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const q = readQuery(input)
    if (q.length < 1) throw new Error("請輸入地名或車站")
    return { q }
  })
  .handler(async ({ data }) => {
    const { lookupAddress } = await import("./als.server")
    return { addresses: await lookupAddress(data.q) }
  })

export const networkSnapshot = createServerFn({ method: "POST" }).handler(async () => {
  const { getRawSnapshot } = await import("./network.server")
  return getRawSnapshot()
})

export const refreshNetwork = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input && typeof input === "object" ? (input as { part?: unknown; shard?: unknown; shards?: unknown }) : {}
    const part = raw.part
    if (part !== "kmb" && part !== "ctb" && part !== "nlb" && part !== "gmb" && part !== "mtr") {
      throw new Error("更新部分不正確")
    }
    const shard = typeof raw.shard === "number" && Number.isInteger(raw.shard) ? raw.shard : 0
    const shards = typeof raw.shards === "number" && Number.isInteger(raw.shards) ? raw.shards : 1
    if (shard < 0 || shards < 1 || shards > 8 || shard >= shards) throw new Error("更新部分不正確")
    return { part, shard, shards }
  })
  .handler(async ({ data }) => {
    const { getRawSnapshot } = await import("./network.server")
    const { rebuildSnapshot } = await import("./rebuild.server")
    return rebuildSnapshot(getRawSnapshot(), data.part, data.shard, data.shards)
  })

export const findBuses = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseSearch(input))
  .handler(async ({ data }) => {
    const { getNetwork } = await import("./network.server")
    const { searchBuses } = await import("./engine")
    return searchBuses(getNetwork(), data)
  })

export const loadEtas = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("到站查詢不正確")
    const items = (input as { items?: unknown }).items
    if (!Array.isArray(items) || items.length < 1 || items.length > 16) {
      throw new Error("到站查詢不正確")
    }
    return { items: items.map(parseEta) }
  })
  .handler(async ({ data }) => {
    const { fetchEtas } = await import("./eta.server")
    return { items: await fetchEtas(data.items) }
  })

function readQuery(input: unknown) {
  if (!input || typeof input !== "object") return ""
  const q = (input as { q?: unknown }).q
  return typeof q === "string" ? q.trim().slice(0, 60) : ""
}

function parseSearch(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("請先選擇位置")
  const raw = input as { origin?: unknown; destination?: unknown; radius?: unknown }
  const origin = parsePoint(raw.origin)
  if (!origin) throw new Error("請選擇出發地")
  const destination = raw.destination == null ? null : parsePoint(raw.destination)
  if (raw.destination != null && !destination) throw new Error("目的地不正確")
  const radius = typeof raw.radius === "number" && Number.isFinite(raw.radius) ? raw.radius : 500
  return { origin, destination, radius }
}

function parsePoint(value: unknown): Point | null {
  if (!value || typeof value !== "object") return null
  const raw = value as { lat?: unknown; lng?: unknown; label?: unknown }
  if (typeof raw.lat !== "number" || typeof raw.lng !== "number") return null
  if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lng)) return null
  if (Math.abs(raw.lat) > 90 || Math.abs(raw.lng) > 180) return null
  const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 80) : ""
  return { lat: raw.lat, lng: raw.lng, label }
}

const COS = new Set<EtaCo>(["kmb", "ctb", "nlb", "gmb", "mtrbus"])

function parseEta(value: unknown): EtaQuery {
  if (!value || typeof value !== "object") throw new Error("到站查詢不正確")
  const raw = value as Record<string, unknown>
  if (typeof raw.co !== "string" || !COS.has(raw.co as EtaCo)) throw new Error("到站查詢不正確")
  if (typeof raw.stopId !== "string" || typeof raw.route !== "string") throw new Error("到站查詢不正確")
  if (typeof raw.serviceType !== "string" || typeof raw.dir !== "string") throw new Error("到站查詢不正確")
  if (typeof raw.seq !== "number" || !Number.isFinite(raw.seq)) throw new Error("到站查詢不正確")
  return {
    co: raw.co as EtaCo,
    stopId: raw.stopId.slice(0, 40),
    route: raw.route.slice(0, 12),
    serviceType: raw.serviceType.slice(0, 8),
    dir: raw.dir.slice(0, 4),
    seq: raw.seq,
    nlbId: typeof raw.nlbId === "string" ? raw.nlbId.slice(0, 12) : null,
    gtfsId: typeof raw.gtfsId === "string" ? raw.gtfsId.slice(0, 16) : null,
  }
}
