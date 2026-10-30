import { etaKey, type EtaHit, type EtaQuery } from "./types"

const UA = "Mozilla/5.0"
const cache = new Map<string, { exp: number; etas: EtaHit[] }>()
const routeStopCache = new Map<string, { exp: number; rows: { stop: string; seq: number }[] }>()

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

async function kmb(q: EtaQuery): Promise<EtaHit[]> {
  const stopId = await resolveKmbStopId(q)
  const url = `https://data.etabus.gov.hk/v1/transport/kmb/eta/${encodeURIComponent(stopId)}/${encodeURIComponent(q.route)}/${encodeURIComponent(q.serviceType)}`
  const data = await getJson<{ data?: KmbEta[] }>(url)
  const rows = data?.data ?? []
  const matched = rows
    .filter(
      (row) =>
        dirOk(row.dir, q.dir) &&
        String(row.service_type ?? "") === q.serviceType &&
        destOk(row.dest_tc, q.destHint),
    )
    .sort((a, b) => (a.eta_seq ?? 99) - (b.eta_seq ?? 99))
  return kmbRowsToHits(matched)
}

async function resolveKmbStopId(q: EtaQuery): Promise<string> {
  const stops = await kmbRouteStops(q.route, q.dir, q.serviceType)
  if (!stops.length) return q.stopId
  const exact = stops.find((row) => row.seq === q.seq)
  if (exact) return exact.stop
  const near = stops.find((row) => Math.abs(row.seq - q.seq) <= 1)
  return near?.stop ?? q.stopId
}

async function kmbRouteStops(route: string, dir: string, serviceType: string) {
  const bound = dir.toUpperCase() === "I" ? "inbound" : "outbound"
  const key = `${route}|${bound}|${serviceType}`
  const cached = routeStopCache.get(key)
  if (cached && cached.exp > Date.now()) return cached.rows
  const url = `https://data.etabus.gov.hk/v1/transport/kmb/route-stop/${encodeURIComponent(route)}/${bound}/${encodeURIComponent(serviceType)}`
  const data = await getJson<{ data?: { stop?: string; seq?: string }[] }>(url)
  const rows = (data?.data ?? [])
    .map((row) => ({ stop: row.stop ?? "", seq: Number(row.seq) }))
    .filter((row) => row.stop && Number.isFinite(row.seq))
  routeStopCache.set(key, { exp: Date.now() + 3_600_000, rows })
  return rows
}

function destOk(destTc: string | undefined, hint: string | null) {
  if (!hint || !destTc) return true
  const normalize = (value: string) =>
    value
      .replace(/[（）()]/g, "")
      .replace(/\s+/g, "")
      .toLowerCase()
  const a = normalize(hint)
  const b = normalize(destTc)
  if (a.includes(b) || b.includes(a)) return true
  const aCore = a.replace(/中環|港澳|碼頭|順利/g, (m) => m).slice(0, 6)
  return b.includes(aCore) || a.includes(b.slice(0, 6))
}

function kmbRowsToHits(rows: KmbEta[]): EtaHit[] {
  const now = Date.now()
  const hits: EtaHit[] = []
  for (const row of rows) {
    const operator = operatorRemark(row.co)
    const baseRemark = keepRemark(row.rmk_tc ?? "")
    const remark = [baseRemark, operator].filter(Boolean).join(" · ")

    if (!row.eta) {
      hits.push({ epoch: null, remark: remark || "暫無實時" })
      continue
    }
    const epoch = Date.parse(row.eta)
    if (!Number.isFinite(epoch)) continue
    if (epoch < now - 90_000) continue
    hits.push({ epoch, remark })
  }
  hits.sort((a, b) => {
    if (a.epoch === null && b.epoch === null) return 0
    if (a.epoch === null) return 1
    if (b.epoch === null) return -1
    return a.epoch - b.epoch
  })
  return hits.slice(0, 5)
}

function operatorRemark(co: string | undefined) {
  const tag = co?.trim().toUpperCase()
  if (tag === "CTB") return "城巴派車"
  if (tag === "KMB") return ""
  return co?.trim() ? co.trim() : ""
}

async function ctb(q: EtaQuery) {
  const url = `https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/${encodeURIComponent(q.stopId)}/${encodeURIComponent(q.route)}`
  const data = await getJson<{ data?: KmbEta[] }>(url)
  const rows = data?.data ?? []
  const matched = rows
    .filter((row) => dirOk(row.dir, q.dir) && destOk(row.dest_tc, q.destHint))
    .sort((a, b) => (a.eta_seq ?? 99) - (b.eta_seq ?? 99))
  return toHits(
    matched.map((row) => ({
      iso: row.eta,
      remark: row.rmk_tc ?? "",
    })),
  )
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
  return hits.slice(0, 5)
}

type KmbEta = {
  co?: string
  eta?: string | null
  eta_seq?: number
  dir?: string
  seq?: number
  service_type?: number | string
  dest_tc?: string
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
    if (epoch < now - 90_000) continue
    hits.push({ epoch, remark: keepRemark(row.remark) })
  }
  hits.sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0))
  const unique: EtaHit[] = []
  for (const hit of hits) {
    if (hit.epoch !== null && unique.some((item) => item.epoch !== null && Math.abs(item.epoch - hit.epoch!) < 30_000)) {
      continue
    }
    unique.push(hit)
    if (unique.length === 5) break
  }
  return unique
}

function keepRemark(value: string) {
  const text = value.trim()
  if (!text) return ""
  if (text === "Scheduled") return "原定班次"
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
