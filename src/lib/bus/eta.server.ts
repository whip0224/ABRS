import { etaKey, type EtaHit, type EtaQuery } from "./types"

const UA = "Mozilla/5.0"
const cache = new Map<string, { exp: number; etas: EtaHit[] }>()

export async function fetchEtas(items: EtaQuery[]) {
  const now = Date.now()
  const rows = await Promise.all(
    items.map(async (item) => {
      const key = etaKey(item)
      const hit = cache.get(key)
      if (hit && hit.exp > now) return { key, etas: hit.etas }
      const etas = await loadOne(item).catch(() => [] as EtaHit[])
      cache.set(key, { exp: now + 20_000, etas })
      return { key, etas }
    }),
  )
  return rows
}

async function loadOne(q: EtaQuery): Promise<EtaHit[]> {
  if (q.co === "kmb") return kmb(q)
  if (q.co === "ctb") return ctb(q)
  if (q.co === "nlb") return nlb(q)
  if (q.co === "gmb") return gmb(q)
  return mtrBus(q)
}

async function kmb(q: EtaQuery) {
  const url = `https://data.etabus.gov.hk/v1/transport/kmb/eta/${encodeURIComponent(q.stopId)}/${encodeURIComponent(q.route)}/${encodeURIComponent(q.serviceType)}`
  const data = await getJson<{ data?: KmbEta[] }>(url)
  const rows = data?.data ?? []
  const matched = rows.filter((row) => dirOk(row.dir, q.dir) && String(row.service_type ?? "") === q.serviceType)
  const seqMatched = matched.filter((row) => Number(row.seq) === q.seq)
  return toHits((seqMatched.length ? seqMatched : matched).map((row) => ({
    iso: row.eta,
    remark: row.rmk_tc ?? "",
  })))
}

async function ctb(q: EtaQuery) {
  const url = `https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/${encodeURIComponent(q.stopId)}/${encodeURIComponent(q.route)}`
  const data = await getJson<{ data?: KmbEta[] }>(url)
  const rows = data?.data ?? []
  const matched = rows.filter((row) => dirOk(row.dir, q.dir))
  const seqMatched = matched.filter((row) => Number(row.seq) === q.seq)
  return toHits((seqMatched.length ? seqMatched : matched).map((row) => ({
    iso: row.eta,
    remark: row.rmk_tc ?? "",
  })))
}

async function nlb(q: EtaQuery) {
  if (!q.nlbId) return []
  const url = `https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=estimatedArrivals&routeId=${encodeURIComponent(q.nlbId)}&stopId=${encodeURIComponent(q.stopId)}&language=zh`
  const data = await getJson<{ estimatedArrivals?: { estimatedArrivalTime?: string; routeVariantName?: string }[] }>(url)
  return toHits(
    (data?.estimatedArrivals ?? []).map((row) => ({
      iso: hkLocal(row.estimatedArrivalTime),
      remark: row.routeVariantName ?? "",
    })),
  )
}

async function gmb(q: EtaQuery) {
  if (!q.gtfsId) return []
  const url = `https://data.etagmb.gov.hk/eta/stop/${encodeURIComponent(q.stopId)}`
  const data = await getJson<{
    data?: { route_id?: number; stop_seq?: number; eta?: { timestamp?: string; remarks_tc?: string }[] }[]
  }>(url)
  const rows = (data?.data ?? []).filter((row) => String(row.route_id ?? "") === q.gtfsId)
  if (!rows.length) return []
  const seqHit = rows.find((row) => Number(row.stop_seq) === q.seq) ?? rows[0]
  return toHits(
    (seqHit.eta ?? []).map((row) => ({
      iso: row.timestamp ?? null,
      remark: row.remarks_tc ?? "",
    })),
  )
}

async function mtrBus(q: EtaQuery) {
  const res = await fetch("https://rt.data.gov.hk/v1/transport/mtr/bus/getSchedule", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ language: "zh", routeName: q.route }),
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) return []
  const data = (await res.json()) as {
    busStop?: { busStopId?: string; bus?: { departureTimeInSecond?: string; departureTimeText?: string; busRemark?: string | null }[] }[]
  }
  const stop = (data.busStop ?? []).find((row) => row.busStopId === q.stopId)
  if (!stop) return []
  const now = Date.now()
  const hits: EtaHit[] = []
  for (const bus of stop.bus ?? []) {
    const text = bus.departureTimeText ?? ""
    const seconds = Number(bus.departureTimeInSecond)
    if (text.includes("已離開")) continue
    if (text.includes("即將")) {
      hits.push({ epoch: now + 30_000, remark: keepRemark(bus.busRemark ?? "") })
      continue
    }
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 7200) continue
    hits.push({ epoch: now + seconds * 1000, remark: keepRemark(bus.busRemark ?? text) })
  }
  return hits.slice(0, 3)
}

type KmbEta = {
  eta?: string | null
  dir?: string
  seq?: number
  service_type?: number | string
  rmk_tc?: string
}

function dirOk(actual: string | undefined, expected: string) {
  if (!expected || !actual) return true
  return actual.toUpperCase() === expected.toUpperCase()
}

function hkLocal(value: string | undefined) {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.includes("+") || trimmed.endsWith("Z")) return trimmed
  return trimmed.replace(" ", "T") + "+08:00"
}

function toHits(rows: { iso: string | null | undefined; remark: string }[]) {
  const now = Date.now()
  const hits: EtaHit[] = []
  for (const row of rows) {
    if (!row.iso) continue
    const epoch = Date.parse(row.iso)
    if (!Number.isFinite(epoch)) continue
    if (epoch < now - 60_000) continue
    hits.push({ epoch, remark: keepRemark(row.remark) })
  }
  hits.sort((a, b) => a.epoch - b.epoch)
  const unique: EtaHit[] = []
  for (const hit of hits) {
    if (unique.some((item) => Math.abs(item.epoch - hit.epoch) < 30_000)) continue
    unique.push(hit)
    if (unique.length === 3) break
  }
  return unique
}

function keepRemark(value: string) {
  const text = value.trim()
  if (!text) return ""
  if (text.includes("原定") || text.includes("未開出") || text === "Scheduled") return ""
  return text.slice(0, 24)
}

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) return null
  return (await res.json()) as T
}
