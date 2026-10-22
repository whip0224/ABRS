import {
  baseName,
  companyLabel,
  type EtaCo,
  type Point,
  type SearchOutput,
  type Suggestion,
  type TripResult,
  type Leg,
} from "./types"

export type RawSnapshot = {
  built: string
  stops: [string, number, number, string, string][]
  routes: [
    string,
    string[],
    string,
    string,
    string,
    string,
    string,
    string | null,
    string | null,
    number | null,
    number[],
  ][]
}

export type NetStop = {
  id: string
  lat: number
  lng: number
  zh: string
  en: string
  base: string
}

export type NetRoute = {
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
  stops: number[]
}

export type Network = {
  built: string
  stops: NetStop[]
  routes: NetRoute[]
  inv: Array<Array<[number, number]>>
  grid: Map<string, number[]>
}

const CELL = 0.005

export type SearchInput = {
  origin: Point
  destination: Point | null
  radius: number
}

export function prepare(raw: RawSnapshot): Network {
  const stops: NetStop[] = raw.stops.map(([id, lat, lng, zh, en]) => ({
    id,
    lat,
    lng,
    zh,
    en,
    base: baseName(zh) || zh,
  }))
  const routes: NetRoute[] = raw.routes.map((row) => ({
    no: row[0],
    co: row[1],
    orig: row[2],
    dest: row[3],
    serviceType: row[4],
    dir: row[5],
    stopCo: row[6],
    nlbId: row[7],
    gtfsId: row[8],
    jt: row[9],
    stops: row[10],
  }))
  const inv: Array<Array<[number, number]>> = stops.map(() => [])
  routes.forEach((route, ri) => {
    route.stops.forEach((si, pos) => {
      inv[si]?.push([ri, pos])
    })
  })
  const grid = new Map<string, number[]>()
  stops.forEach((stop, index) => {
    const key = cellKey(stop.lat, stop.lng)
    const bucket = grid.get(key)
    if (bucket) bucket.push(index)
    else grid.set(key, [index])
  })
  return { built: raw.built, stops, routes, inv, grid }
}

export function suggestStops(net: Network, query: string, limit = 8): Suggestion[] {
  const q = query.trim().toLowerCase()
  const compact = q.replace(/\s+/g, "")
  if (compact.length < 1) return []
  const scored: { si: number; score: number }[] = []
  for (let i = 0; i < net.stops.length; i++) {
    const stop = net.stops[i]
    const zh = stop.zh.toLowerCase()
    const base = stop.base.toLowerCase().replace(/\s+/g, "")
    const en = stop.en.toLowerCase()
    let score = 0
    if (base === compact || zh === q) score = 100
    else if (base.startsWith(compact)) score = 82
    else if (base.includes(compact) || zh.includes(q)) score = 64
    else if (en.includes(q)) score = 48
    else continue
    score += Math.max(0, 16 - stop.base.length / 6)
    scored.push({ si: i, score })
  }
  scored.sort((a, b) => b.score - a.score || a.si - b.si)
  const top = scored.slice(0, 100)
  const clusters: { members: { si: number; score: number }[] }[] = []
  for (const item of top) {
    const stop = net.stops[item.si]
    let placed = false
    for (const cluster of clusters) {
      const head = net.stops[cluster.members[0].si]
      if (head.base === stop.base && haversine(head.lat, head.lng, stop.lat, stop.lng) < 240) {
        cluster.members.push(item)
        placed = true
        break
      }
    }
    if (!placed) clusters.push({ members: [item] })
  }
  clusters.sort((a, b) => {
    const as = Math.max(...a.members.map((m) => m.score))
    const bs = Math.max(...b.members.map((m) => m.score))
    if (bs !== as) return bs - as
    return b.members.length - a.members.length
  })
  return clusters.slice(0, limit).map((cluster) => {
    const points = cluster.members.map((m) => net.stops[m.si])
    const lat = median(points.map((p) => p.lat))
    const lng = median(points.map((p) => p.lng))
    let best = points[0]
    let bestDist = Infinity
    for (const point of points) {
      const dist = haversine(lat, lng, point.lat, point.lng)
      if (dist < bestDist) {
        best = point
        bestDist = dist
      }
    }
    const detail =
      cluster.members.length > 1
        ? `${cluster.members.length} 個同名車站`
        : best.en
    return {
      id: best.id,
      label: best.base,
      detail,
      lat: best.lat,
      lng: best.lng,
      kind: "stop" as const,
    }
  })
}

export function searchBuses(net: Network, input: SearchInput, now = new Date()): SearchOutput {
  const requested = clamp(input.radius, 250, 1000)
  const origin = input.origin
  const destination = input.destination
  if (
    !inHongKong(origin.lat, origin.lng) ||
    (destination && !inHongKong(destination.lat, destination.lng))
  ) {
    return blank(net.built, requested, null, "呢個位置唔喺香港巴士範圍。")
  }
  const straight = destination
    ? Math.round(haversine(origin.lat, origin.lng, destination.lat, destination.lng))
    : null
  if (destination && straight !== null && straight < 220) {
    return blank(net.built, requested, straight, "兩個位置太近，行路可能更快。")
  }
  if (!destination) {
    const passing = findPassing(net, origin, requested, now)
    return {
      built: net.built,
      radius: requested,
      widenedTo: null,
      straightM: null,
      note: passing.length ? null : "附近搵唔到車站，試下放大範圍或改個地名。",
      directs: [],
      transfers: [],
      passing,
    }
  }
  let radius = requested
  let directs = preferDay(findDirect(net, origin, destination, radius, now), now)
  let widenedTo: number | null = null
  if (directs.length < 3 && requested < 900) {
    const wider = Math.min(1000, requested + 350)
    const more = findDirect(net, origin, destination, wider, now)
    if (more.length > directs.length) {
      directs = preferDay(more, now)
      radius = wider
      widenedTo = wider
    }
  }
  const directNos = new Set(directs.map((trip) => trip.legs[0]?.routeNo).filter(Boolean))
  const transfers =
    directs.length < 5 && straight !== null && straight > 1200
      ? findTransfers(net, origin, destination, radius, now).filter((trip) => {
          const first = trip.legs[0]?.routeNo
          const second = trip.legs[1]?.routeNo
          return first && second && !directNos.has(first) && !directNos.has(second)
        })
      : []
  let passing: TripResult[] = []
  const notes: string[] = []
  if (widenedTo) notes.push(`附近結果較少，已擴大至 ${widenedTo} 米搜尋。`)
  if (!directs.length && !transfers.length) {
    passing = findPassing(net, origin, radius, now).slice(0, 12)
    notes.push("未找到直達或一次轉車，以下是出發地途經的路線。")
  }
  return {
    built: net.built,
    radius,
    widenedTo,
    straightM: straight,
    note: notes.length ? notes.join(" ") : null,
    directs,
    transfers,
    passing,
  }
}

function findDirect(
  net: Network,
  origin: Point,
  destination: Point,
  radius: number,
  now: Date,
) {
  const origins = near(net, origin.lat, origin.lng, radius, 400)
  const dests = near(net, destination.lat, destination.lng, radius, 400)
  const destDist = new Map(dests.map((hit) => [hit.si, hit.dist]))
  const day = isDay(now)
  const best = new Map<string, { score: number; trip: TripResult }>()
  for (const hit of origins) {
    for (const [ri, pos] of net.inv[hit.si] ?? []) {
      const route = net.routes[ri]
      const seq = route.stops
      let alight = -1
      let alightCost = Infinity
      let alightWalk = 0
      for (let j = pos + 1; j < seq.length; j++) {
        const walk = destDist.get(seq[j])
        if (walk === undefined) continue
        const cost = walk + (j - pos) * 45
        if (cost < alightCost) {
          alightCost = cost
          alight = j
          alightWalk = walk
        }
      }
      if (alight < 0) continue
      const between = alight - pos
      const score = hit.dist + alightWalk + between * 55 + routePenalty(route, day)
      const key = `${route.no}|${route.co.join("+")}|${route.dir}|${route.orig}|${route.dest}`
      const prev = best.get(key)
      if (prev && prev.score <= score) continue
      const board = net.stops[seq[pos]]
      const off = net.stops[seq[alight]]
      const leg = makeLeg(net, route, pos, alight, hit.dist, alightWalk)
      best.set(key, {
        score,
        trip: {
          id: `d|${route.no}|${route.dir}|${route.serviceType}|${board.id}|${off.id}`,
          kind: "direct",
          legs: [leg],
          transferName: null,
        },
      })
    }
  }
  return [...best.values()]
    .sort((a, b) => a.score - b.score || compareRoute(a.trip.legs[0].routeNo, b.trip.legs[0].routeNo))
    .slice(0, 18)
    .map((row) => row.trip)
}

function findPassing(net: Network, origin: Point, radius: number, now: Date) {
  const hits = near(net, origin.lat, origin.lng, radius, 80)
  const day = isDay(now)
  const best = new Map<string, { score: number; trip: TripResult }>()
  for (const hit of hits) {
    for (const [ri, pos] of net.inv[hit.si] ?? []) {
      const route = net.routes[ri]
      if (pos >= route.stops.length - 1) continue
      const key = `${route.no}|${route.co.join("+")}|${route.dir}|${route.orig}|${route.dest}`
      const score = hit.dist + routePenalty(route, day)
      const prev = best.get(key)
      if (prev && prev.score <= score) continue
      const board = net.stops[route.stops[pos]]
      const leg = makeLeg(net, route, pos, null, hit.dist, null)
      best.set(key, {
        score,
        trip: {
          id: `p|${route.no}|${route.dir}|${route.serviceType}|${board.id}`,
          kind: "passing",
          legs: [leg],
          transferName: null,
        },
      })
    }
  }
  return [...best.values()]
    .sort((a, b) => a.score - b.score || compareRoute(a.trip.legs[0].routeNo, b.trip.legs[0].routeNo))
    .slice(0, 30)
    .map((row) => row.trip)
}

function findTransfers(
  net: Network,
  origin: Point,
  destination: Point,
  radius: number,
  now: Date,
) {
  const origins = near(net, origin.lat, origin.lng, radius, 40)
  const dests = near(net, destination.lat, destination.lng, radius, 60)
  const destDist = new Map(dests.map((hit) => [hit.si, hit.dist]))
  const day = isDay(now)
  const first: { ri: number; pos: number; walk: number }[] = []
  for (const hit of origins) {
    for (const [ri, pos] of net.inv[hit.si] ?? []) {
      if (pos >= net.routes[ri].stops.length - 2) continue
      first.push({ ri, pos, walk: hit.dist })
    }
  }
  first.sort((a, b) => a.walk - b.walk)
  const best = new Map<string, { score: number; trip: TripResult }>()
  for (const leg of first.slice(0, 140)) {
    const route = net.routes[leg.ri]
    const seq = route.stops
    const maxJ = Math.min(seq.length - 1, leg.pos + 14)
    for (let j = leg.pos + 2; j <= maxJ; j++) {
      const transferSi = seq[j]
      const transfer = net.stops[transferSi]
      if (haversine(origin.lat, origin.lng, transfer.lat, transfer.lng) < 350) continue
      if (haversine(destination.lat, destination.lng, transfer.lat, transfer.lng) < 350) continue
      for (const [ri2, pos2] of net.inv[transferSi] ?? []) {
        if (ri2 === leg.ri) continue
        const second = net.routes[ri2]
        if (second.no === route.no) continue
        if (pos2 >= second.stops.length - 1) continue
        let alight = -1
        let alightCost = Infinity
        let alightWalk = 0
        for (let p = pos2 + 1; p < second.stops.length; p++) {
          const walk = destDist.get(second.stops[p])
          if (walk === undefined) continue
          const cost = walk + (p - pos2) * 45
          if (cost < alightCost) {
            alightCost = cost
            alight = p
            alightWalk = walk
          }
        }
        if (alight < 0) continue
        const between1 = j - leg.pos
        const between2 = alight - pos2
        const score =
          leg.walk +
          alightWalk +
          between1 * 50 +
          between2 * 50 +
          240 +
          routePenalty(route, day) +
          routePenalty(second, day)
        const key = `${route.no}|${route.dir}|${second.no}|${second.dir}`
        const prev = best.get(key)
        if (prev && prev.score <= score) continue
        const board = net.stops[seq[leg.pos]]
        const off = net.stops[second.stops[alight]]
        best.set(key, {
          score,
          trip: {
            id: `t|${route.no}|${second.no}|${transfer.id}|${board.id}|${off.id}`,
            kind: "transfer",
            transferName: transfer.base,
            legs: [
              makeLeg(net, route, leg.pos, j, leg.walk, 0),
              makeLeg(net, second, pos2, alight, 0, alightWalk),
            ],
          },
        })
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => a.score - b.score)
    .slice(0, 6)
    .map((row) => row.trip)
}

function makeLeg(
  net: Network,
  route: NetRoute,
  boardPos: number,
  alightPos: number | null,
  boardWalk: number,
  alightWalk: number | null,
): Leg {
  const board = net.stops[route.stops[boardPos]]
  const alight = alightPos === null ? null : net.stops[route.stops[alightPos]]
  return {
    routeNo: route.no,
    companies: route.co,
    companyLabel: companyLabel(route.co, route.no),
    orig: route.orig,
    dest: route.dest,
    special: route.serviceType !== "1",
    night: /^N/i.test(route.no),
    boardName: board.base,
    boardLat: board.lat,
    boardLng: board.lng,
    alightName: alight ? alight.base : null,
    boardWalkM: Math.round(boardWalk),
    alightWalkM: alightWalk === null ? null : Math.round(alightWalk),
    stopsBetween: alightPos === null ? null : alightPos - boardPos,
    estMin:
      alightPos === null ? null : estimateMinutes(route.jt, boardPos, alightPos, route.stops.length),
    eta: {
      co: etaCompany(route.stopCo),
      stopId: board.id,
      route: route.no,
      serviceType: route.serviceType,
      dir: route.dir,
      seq: boardPos + 1,
      nlbId: route.nlbId,
      gtfsId: route.gtfsId,
    },
  }
}

function etaCompany(stopCo: string): EtaCo {
  if (stopCo === "kmb" || stopCo === "ctb" || stopCo === "nlb" || stopCo === "gmb") return stopCo
  return "mtrbus"
}

function estimateMinutes(jt: number | null, boardPos: number, alightPos: number, total: number) {
  if (!jt || jt <= 0) return null
  const span = Math.max(1, total - 1)
  const ride = Math.max(1, alightPos - boardPos)
  return Math.max(3, Math.round((jt * ride) / span))
}

function routePenalty(route: NetRoute, day: boolean) {
  let penalty = 0
  if (route.serviceType !== "1") penalty += 90
  if (day && /^N/i.test(route.no)) penalty += 340
  return penalty
}

function near(net: Network, lat: number, lng: number, radius: number, limit: number) {
  const dLat = radius / 111320
  const dLng = radius / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  const a0 = Math.floor((lat - dLat) / CELL)
  const a1 = Math.floor((lat + dLat) / CELL)
  const b0 = Math.floor((lng - dLng) / CELL)
  const b1 = Math.floor((lng + dLng) / CELL)
  const hits: { si: number; dist: number }[] = []
  for (let a = a0; a <= a1; a++) {
    for (let b = b0; b <= b1; b++) {
      const bucket = net.grid.get(`${a}:${b}`)
      if (!bucket) continue
      for (const si of bucket) {
        const stop = net.stops[si]
        const dist = haversine(lat, lng, stop.lat, stop.lng)
        if (dist <= radius) hits.push({ si, dist })
      }
    }
  }
  hits.sort((a, b) => a.dist - b.dist)
  return hits.slice(0, limit)
}

function cellKey(lat: number, lng: number) {
  return `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`
}

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dp = ((lat2 - lat1) * Math.PI) / 180
  const dl = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function inHongKong(lat: number, lng: number) {
  return lat >= 22.13 && lat <= 22.58 && lng >= 113.82 && lng <= 114.45
}

function isDay(now: Date) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Hong_Kong",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  )
  return hour >= 6 && hour < 23
}

function compareRoute(a: string, b: string) {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function preferDay(trips: TripResult[], now: Date) {
  if (!isDay(now)) return trips
  const daytime = trips.filter((trip) => !trip.legs[0]?.night)
  return daytime.length >= 2 ? daytime : trips
}

function blank(built: string, radius: number, straightM: number | null, note: string): SearchOutput {
  return {
    built,
    radius,
    widenedTo: null,
    straightM,
    note,
    directs: [],
    transfers: [],
    passing: [],
  }
}
