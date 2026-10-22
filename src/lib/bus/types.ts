export type Point = {
  label: string
  lat: number
  lng: number
}

export type Suggestion = {
  id: string
  label: string
  detail: string
  lat: number
  lng: number
  kind: "stop" | "address"
}

export type EtaCo = "kmb" | "ctb" | "nlb" | "gmb" | "mtrbus"

export type EtaQuery = {
  co: EtaCo
  stopId: string
  route: string
  serviceType: string
  dir: string
  seq: number
  nlbId: string | null
  gtfsId: string | null
}

export type EtaHit = {
  epoch: number
  remark: string
}

export type Leg = {
  routeNo: string
  companies: string[]
  companyLabel: string
  orig: string
  dest: string
  special: boolean
  night: boolean
  boardName: string
  boardLat: number
  boardLng: number
  alightName: string | null
  boardWalkM: number
  alightWalkM: number | null
  stopsBetween: number | null
  estMin: number | null
  eta: EtaQuery
}

export type TripResult = {
  id: string
  kind: "direct" | "passing" | "transfer"
  legs: Leg[]
  transferName: string | null
}

export type SearchOutput = {
  built: string
  radius: number
  widenedTo: number | null
  straightM: number | null
  note: string | null
  directs: TripResult[]
  transfers: TripResult[]
  passing: TripResult[]
}

export function baseName(zh: string) {
  return zh
    .replace(/\s*[（(][A-Za-z0-9][A-Za-z0-9 ./-]*[）)]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function companyLabel(companies: string[], routeNo: string) {
  if (routeNo === "506" && companies.length === 1 && companies[0] === "lrtfeeder") {
    return "輕鐵"
  }
  const map: Record<string, string> = {
    kmb: "九巴",
    ctb: "城巴",
    nlb: "嶼巴",
    gmb: "小巴",
    lrtfeeder: "港鐵巴士",
  }
  const order = ["kmb", "ctb", "nlb", "gmb", "lrtfeeder"]
  const parts = order.filter((co) => companies.includes(co)).map((co) => map[co])
  return parts.join(" · ") || "巴士"
}

export function etaKey(q: EtaQuery) {
  return [q.co, q.stopId, q.route, q.serviceType, q.dir, q.seq, q.nlbId ?? "", q.gtfsId ?? ""].join("|")
}

export function formatWalk(meters: number) {
  if (meters < 70) return "就在車站"
  const rounded = Math.round(meters / 10) * 10
  return `步行 ${rounded} 米`
}

export function formatEta(epoch: number, now = Date.now()) {
  const minutes = Math.round((epoch - now) / 60000)
  if (minutes <= 0) return "即將"
  return `${minutes} 分鐘`
}
