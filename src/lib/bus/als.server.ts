import type { Suggestion } from "./types"

export async function lookupAddress(query: string): Promise<Suggestion[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 2500)
  try {
    const res = await fetch(
      `https://www.als.gov.hk/lookup?q=${encodeURIComponent(q)}&n=3`,
      {
        signal: ctrl.signal,
        headers: {
          Accept: "application/xml",
          "User-Agent": "Mozilla/5.0",
        },
      },
    )
    if (!res.ok) return []
    const xml = await res.text()
    return parseAls(xml, q).slice(0, 3)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

function parseAls(xml: string, query: string): Suggestion[] {
  const blocks = xml.split("<SuggestedAddress>").slice(1)
  const core = placeCore(query)
  const ranked: { item: Suggestion; rank: number }[] = []
  for (const block of blocks) {
    const lat = Number(block.match(/<Latitude>([0-9.]+)<\/Latitude>/)?.[1])
    const lng = Number(block.match(/<Longitude>([0-9.]+)<\/Longitude>/)?.[1])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    if (lat < 22.13 || lat > 22.58 || lng < 113.82 || lng > 114.45) continue
    const building = decode(text(block, /<ChiPremisesAddress>[\s\S]*?<BuildingName>([^<]+)<\/BuildingName>/))
    const estate = decode(text(block, /<ChiEstate>[\s\S]*?<EstateName>([^<]+)<\/EstateName>/))
    const street = decode(text(block, /<ChiStreet>[\s\S]*?<StreetName>([^<]+)<\/StreetName>/))
    const number = text(block, /<ChiStreet>[\s\S]*?<BuildingNoFrom>([^<]+)<\/BuildingNoFrom>/)
    const district = decode(text(block, /<ChiDistrict>[\s\S]*?<DcDistrict>([^<]+)<\/DcDistrict>/))
    const blob = `${building}${estate}${street}`
    if (core.length >= 2 && !blob.includes(core)) continue
    const compact = query.replace(/\s+/g, "")
    if (core.length < 2 && compact.length >= 2 && bigramHits(compact, blob) < 2) continue
    const name = [building, estate]
      .filter(Boolean)
      .sort((a, b) => bigramHits(compact, b) - bigramHits(compact, a) || a.length - b.length)[0]
    const streetLine = street ? `${street}${number ? `${number}號` : ""}` : ""
    const label = name || streetLine || district
    if (!label || label === district) continue
    const score = Number(block.match(/<Score>([0-9.]+)<\/Score>/)?.[1] ?? 0)
    const detail = [streetLine && streetLine !== label ? streetLine : "", district].filter(Boolean).join(" · ") || "地址"
    ranked.push({
      rank: bigramHits(compact, label) * 100 + (blob.includes(compact) ? 80 : 0) + score,
      item: {
        id: `addr-${lat.toFixed(5)}-${lng.toFixed(5)}`,
        label,
        detail: detail ? `${detail} · 地址` : "地址",
        lat,
        lng,
        kind: "address",
      },
    })
  }
  ranked.sort((a, b) => b.rank - a.rank)
  return ranked.map((row) => row.item)
}

const FACILITY = [
  "學生健康服務中心",
  "健康服務中心",
  "社區服務中心",
  "服務中心",
  "官立小學",
  "官立中學",
  "健康中心",
  "診療所",
  "小學",
  "中學",
  "書院",
  "醫院",
  "診所",
  "商場",
  "中心",
  "大樓",
]

function placeCore(query: string) {
  let q = query.replace(/\s+/g, "")
  for (let i = 0; i < 4 && q.length > 2; i++) {
    const hit = FACILITY.find((word) => q.endsWith(word) && q.length - word.length >= 2)
    if (!hit) break
    q = q.slice(0, -hit.length)
  }
  return q
}

function bigramHits(query: string, name: string) {
  if (query.length < 2 || name.length < 2) return name.includes(query) ? 1 : 0
  let hits = 0
  for (let i = 0; i < query.length - 1; i++) {
    if (name.includes(query.slice(i, i + 2))) hits++
  }
  return hits
}

function decode(value: string) {
  return value
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/'/g, "'")
}

function text(block: string, pattern: RegExp) {
  return block.match(pattern)?.[1]?.trim() ?? ""
}
