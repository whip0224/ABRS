import type { RawSnapshot } from "./engine"

type StopRow = RawSnapshot["stops"][number]
type RouteRow = RawSnapshot["routes"][number]

const UA = "touhou-hk-bus"

export async function rebuildSnapshot(
  previous: RawSnapshot,
  only?: string,
  shard = 0,
  shards = 1,
): Promise<RawSnapshot> {
  const prevStop = new Map(previous.stops.map((row) => [row[0], row]))
  const prevJt = new Map<string, number>()
  for (const row of previous.routes) {
    if (typeof row[9] === "number") prevJt.set(`${row[0]}|${row[5]}|${row[4]}|${row[6]}`, row[9])
  }
  const stops: StopRow[] = []
  const index = new Map<string, number>()
  const routes: RouteRow[] = []

  function stopIndex(id: string, lat: number, lng: number, zh: string, en: string) {
    const known = index.get(id)
    if (known !== undefined) {
      if (!Number.isFinite(stops[known][1]) && Number.isFinite(lat)) {
        stops[known] = [id, lat, lng, zh || stops[known][3], en || stops[known][4]]
      }
      return known
    }
    const prev = prevStop.get(id)
    const next: StopRow = [
      id,
      Number.isFinite(lat) ? lat : (prev?.[1] ?? Number.NaN),
      Number.isFinite(lng) ? lng : (prev?.[2] ?? Number.NaN),
      zh || prev?.[3] || id,
      en || prev?.[4] || "",
    ]
    if (!Number.isFinite(next[1]) || !Number.isFinite(next[2])) return null
    const at = stops.length
    stops.push(next)
    index.set(id, at)
    return at
  }

  function addRoute(
    no: string,
    co: string[],
    orig: string,
    dest: string,
    serviceType: string,
    dir: string,
    stopCo: string,
    nlbId: string | null,
    gtfsId: string | null,
    stopIds: number[],
  ) {
    if (stopIds.length < 2 || !no || !orig) return
    const jt = prevJt.get(`${no}|${dir}|${serviceType}|${stopCo}`) ?? null
    routes.push([no, co, orig, dest, serviceType, dir, stopCo, nlbId, gtfsId, jt, stopIds])
  }

  if (!only || only === "kmb") await rebuildKmb(stopIndex, addRoute)
  if (!only || only === "ctb") await rebuildCtb(stopIndex, addRoute, shard, shards)
  if (!only || only === "nlb") await rebuildNlb(stopIndex, addRoute)
  if (!only || only === "gmb") await rebuildGmb(stopIndex, addRoute, shard, shards)
  if (!only || only === "mtr") await rebuildMtr(stopIndex, addRoute)

  const merged = only === "kmb" || only === "ctb" || !only ? mergeJoint(routes) : routes
  if (only) {
    if (shards > 1) {
      if (merged.length < 1) throw new Error("這部分路線更新未完整，仍用手機裡的資料。")
    } else {
      const counts = countBy(merged)
      const min = only === "nlb" || only === "mtr" ? 30 : only === "ctb" ? 500 : only === "gmb" ? 700 : 1400
      const key = only === "mtr" ? "lrtfeeder" : only
      if ((counts[key] ?? 0) < min) {
        throw new Error("這部分路線更新未完整，仍用手機裡的資料。")
      }
    }
    return { built: new Date().toISOString().slice(0, 10), stops, routes: merged }
  }
  const counts = countBy(merged)
  const need: [string, number][] = [
    ["kmb", 1400],
    ["ctb", 500],
    ["nlb", 40],
    ["gmb", 700],
    ["lrtfeeder", 30],
  ]
  const short = need.filter(([co, min]) => (counts[co] ?? 0) < min)
  if (short.length) {
    throw new Error(`路線更新未完整（${short.map(([co]) => co).join("、")}），仍用手機裡的資料。`)
  }
  return {
    built: new Date().toISOString().slice(0, 10),
    stops,
    routes: merged,
  }
}

function countBy(routes: RouteRow[]) {
  const counts: Record<string, number> = {}
  for (const row of routes) counts[row[6]] = (counts[row[6]] ?? 0) + 1
  return counts
}

function mergeJoint(routes: RouteRow[]) {
  const seen = new Map<string, RouteRow>()
  const out: RouteRow[] = []
  for (const route of routes) {
    const co = route[1][0]
    if (co !== "kmb" && co !== "ctb") {
      out.push(route)
      continue
    }
    const key = `${route[0]}|${route[5]}|${route[4]}`
    const other = seen.get(key)
    if (!other) {
      seen.set(key, route)
      out.push(route)
      continue
    }
    if (other[1][0] === co) continue
    other[1] = ["kmb", "ctb"]
    if (route[10].length > other[10].length) {
      other[2] = route[2]
      other[3] = route[3]
      other[6] = route[6]
      other[10] = route[10]
    }
  }
  return out
}

async function rebuildKmb(
  stopIndex: (id: string, lat: number, lng: number, zh: string, en: string) => number | null,
  addRoute: (
    no: string,
    co: string[],
    orig: string,
    dest: string,
    serviceType: string,
    dir: string,
    stopCo: string,
    nlbId: string | null,
    gtfsId: string | null,
    stopIds: number[],
  ) => void,
) {
  const [stopData, routeData, routeStopData] = await Promise.all([
    getJson<{ data: { stop: string; name_tc: string; name_en: string; lat: string; long: string }[] }>(
      "https://data.etabus.gov.hk/v1/transport/kmb/stop/",
    ),
    getJson<{ data: { route: string; bound: string; service_type: string; orig_tc: string; dest_tc: string }[] }>(
      "https://data.etabus.gov.hk/v1/transport/kmb/route/",
    ),
    getJson<{ data: { route: string; bound: string; service_type: string; seq: string; stop: string }[] }>(
      "https://data.etabus.gov.hk/v1/transport/kmb/route-stop/",
    ),
  ])
  const stops = new Map(stopData.data.map((row) => [row.stop, row]))
  const groups = new Map<string, { seq: number; stop: string }[]>()
  for (const row of routeStopData.data) {
    const key = `${row.route}|${row.bound}|${row.service_type}`
    const list = groups.get(key) ?? []
    list.push({ seq: Number(row.seq), stop: row.stop })
    groups.set(key, list)
  }
  for (const route of routeData.data) {
    const dir = route.bound === "I" ? "I" : "O"
    const rows = groups.get(`${route.route}|${route.bound}|${route.service_type}`) ?? []
    rows.sort((a, b) => a.seq - b.seq)
    const ids: number[] = []
    for (const row of rows) {
      const stop = stops.get(row.stop)
      const at = stopIndex(row.stop, Number(stop?.lat), Number(stop?.long), stop?.name_tc ?? "", stop?.name_en ?? "")
      if (at !== null) ids.push(at)
    }
    addRoute(route.route, ["kmb"], route.orig_tc, route.dest_tc, route.service_type || "1", dir, "kmb", null, null, ids)
  }
}

async function rebuildCtb(
  stopIndex: (id: string, lat: number, lng: number, zh: string, en: string) => number | null,
  addRoute: (
    no: string,
    co: string[],
    orig: string,
    dest: string,
    serviceType: string,
    dir: string,
    stopCo: string,
    nlbId: string | null,
    gtfsId: string | null,
    stopIds: number[],
  ) => void,
  shard = 0,
  shards = 1,
) {
  const routeData = await getJson<{ data: { route: string; orig_tc: string; dest_tc: string }[] }>(
    "https://rt.data.gov.hk/v2/transport/citybus/route/CTB",
  )
  await pool(
    routeData.data.filter((_, index) => index % shards === shard),
    8,
    async (route) => {
      for (const [bound, dir] of [
        ["outbound", "O"],
        ["inbound", "I"],
      ] as const) {
        let rows: { seq: number; stop: string }[] = []
        try {
          const data = await getJson<{ data: { seq: number; stop: string }[] }>(
            `https://rt.data.gov.hk/v2/transport/citybus/route-stop/CTB/${encodeURIComponent(route.route)}/${bound}`,
          )
          rows = data.data ?? []
        } catch {
          continue
        }
        rows.sort((a, b) => a.seq - b.seq)
        const ids: number[] = []
        for (const row of rows) {
          let at = stopIndex(row.stop, Number.NaN, Number.NaN, "", "")
          if (at === null) {
            try {
              const stop = await getJson<{ data: { name_tc: string; name_en: string; lat: string; long: string } }>(
                `https://rt.data.gov.hk/v2/transport/citybus/stop/${encodeURIComponent(row.stop)}`,
              )
              at = stopIndex(row.stop, Number(stop.data.lat), Number(stop.data.long), stop.data.name_tc, stop.data.name_en)
            } catch {
              continue
            }
          }
          if (at !== null) ids.push(at)
        }
        const orig = dir === "O" ? route.orig_tc : route.dest_tc
        const dest = dir === "O" ? route.dest_tc : route.orig_tc
        addRoute(route.route, ["ctb"], orig, dest, "1", dir, "ctb", null, null, ids)
      }
    },
  )
}

async function rebuildNlb(
  stopIndex: (id: string, lat: number, lng: number, zh: string, en: string) => number | null,
  addRoute: (
    no: string,
    co: string[],
    orig: string,
    dest: string,
    serviceType: string,
    dir: string,
    stopCo: string,
    nlbId: string | null,
    gtfsId: string | null,
    stopIds: number[],
  ) => void,
) {
  const list = await getJson<{ routes: { routeId: string; routeNo: string; routeName_c: string }[] }>(
    "https://rt.data.gov.hk/v2/transport/nlb/route.php?action=list",
  )
  await pool(list.routes ?? [], 8, async (route) => {
    let stops: { stopId: string; stopName_c: string; stopName_e: string; latitude: string; longitude: string }[] = []
    try {
      const data = await getJson<{
        stops: { stopId: string; stopName_c: string; stopName_e: string; latitude: string; longitude: string }[]
      }>(`https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=list&routeId=${encodeURIComponent(route.routeId)}`)
      stops = data.stops ?? []
    } catch {
      return
    }
    const ids: number[] = []
    for (const stop of stops) {
      const at = stopIndex(stop.stopId, Number(stop.latitude), Number(stop.longitude), stop.stopName_c, stop.stopName_e)
      if (at !== null) ids.push(at)
    }
    const [orig, dest] = route.routeName_c.split(">").map((part) => part.trim())
    addRoute(route.routeNo, ["nlb"], orig || route.routeName_c, dest || orig || "", "1", "O", "nlb", route.routeId, null, ids)
  })
}

async function rebuildGmb(
  stopIndex: (id: string, lat: number, lng: number, zh: string, en: string) => number | null,
  addRoute: (
    no: string,
    co: string[],
    orig: string,
    dest: string,
    serviceType: string,
    dir: string,
    stopCo: string,
    nlbId: string | null,
    gtfsId: string | null,
    stopIds: number[],
  ) => void,
  shard = 0,
  shards = 1,
) {
  const list = await getJson<{ data: { routes: Record<string, string[]> } }>("https://data.etagmb.gov.hk/route/")
  const jobs: { region: string; code: string }[] = []
  for (const [region, codes] of Object.entries(list.data?.routes ?? {})) {
    for (const code of codes) jobs.push({ region, code })
  }
  const picked = jobs.filter((_, index) => index % shards === shard)
  const failed: { region: string; code: string }[] = []
  let blocked = 0
  async function one(job: { region: string; code: string }, collect: boolean) {
    if (blocked >= 20) return
    let variants: {
      route_id: number
      directions: { route_seq: number; orig_tc: string; dest_tc: string }[]
    }[] = []
    try {
      const data = await getJson<{
        data: { route_id: number; directions: { route_seq: number; orig_tc: string; dest_tc: string }[] }[]
      }>(`https://data.etagmb.gov.hk/route/${encodeURIComponent(job.region)}/${encodeURIComponent(job.code)}`)
      variants = data.data ?? []
    } catch (err) {
      noteBlock(err, () => {
        blocked += 1
      })
      if (collect) failed.push(job)
      return
    }
    for (let variant = 0; variant < variants.length; variant++) {
      const item = variants[variant]
      for (const direction of item.directions ?? []) {
        let rows: { stop_seq: number; stop_id: number; name_tc: string; name_en: string }[] = []
        try {
          const data = await getJson<{
            data: { route_stops: { stop_seq: number; stop_id: number; name_tc: string; name_en: string }[] }
          }>(`https://data.etagmb.gov.hk/route-stop/${item.route_id}/${direction.route_seq}`)
          rows = data.data?.route_stops ?? []
        } catch (err) {
          noteBlock(err, () => {
            blocked += 1
          })
          continue
        }
        rows.sort((a, b) => a.stop_seq - b.stop_seq)
        const ids: number[] = []
        for (const row of rows) {
          const id = String(row.stop_id)
          const atKnown = stopIndex(id, Number.NaN, Number.NaN, row.name_tc, row.name_en)
          let at = atKnown
          if (at === null) {
            try {
              const stop = await getJson<{ data: { coordinates?: { wgs84?: { latitude: number; longitude: number } } } }>(
                `https://data.etagmb.gov.hk/stop/${id}`,
              )
              at = stopIndex(
                id,
                Number(stop.data?.coordinates?.wgs84?.latitude),
                Number(stop.data?.coordinates?.wgs84?.longitude),
                row.name_tc,
                row.name_en,
              )
            } catch {
              continue
            }
          }
          if (at !== null) ids.push(at)
        }
        const dir = direction.route_seq === 2 ? "I" : "O"
        addRoute(
          job.code,
          ["gmb"],
          direction.orig_tc,
          direction.dest_tc,
          String(variant + 1),
          dir,
          "gmb",
          null,
          String(item.route_id),
          ids,
        )
      }
    }
  }
  await pool(picked, 4, (job) => one(job, true))
  if (failed.length) await pool(failed, 2, (job) => one(job, false))
}

async function rebuildMtr(
  stopIndex: (id: string, lat: number, lng: number, zh: string, en: string) => number | null,
  addRoute: (
    no: string,
    co: string[],
    orig: string,
    dest: string,
    serviceType: string,
    dir: string,
    stopCo: string,
    nlbId: string | null,
    gtfsId: string | null,
    stopIds: number[],
  ) => void,
) {
  const [routeCsv, stopCsv] = await Promise.all([
    getText("https://opendata.mtr.com.hk/data/mtr_bus_routes.csv"),
    getText("https://opendata.mtr.com.hk/data/mtr_bus_stops.csv"),
  ])
  const names = new Map<string, { chi: string; eng: string }>()
  for (const row of parseCsv(routeCsv).slice(1)) {
    names.set(row[0], { chi: row[1] ?? "", eng: row[2] ?? "" })
  }
  const groups = new Map<string, { seq: number; id: string; lat: number; lng: number; zh: string; en: string }[]>()
  for (const row of parseCsv(stopCsv).slice(1)) {
    const key = `${row[0]}|${row[1]}`
    const list = groups.get(key) ?? []
    list.push({
      seq: Number(row[2]),
      id: row[3],
      lat: Number(row[4]),
      lng: Number(row[5]),
      zh: row[6] ?? "",
      en: row[7] ?? "",
    })
    groups.set(key, list)
  }
  for (const [key, list] of groups) {
    const [routeId, dirRaw] = key.split("|")
    const dir = dirRaw === "I" ? "I" : "O"
    list.sort((a, b) => a.seq - b.seq)
    const ids: number[] = []
    for (const stop of list) {
      const at = stopIndex(stop.id, stop.lat, stop.lng, stop.zh, stop.en)
      if (at !== null) ids.push(at)
    }
    const name = names.get(routeId)?.chi ?? routeId
    const parts = name.split("至").map((part) => part.trim())
    const orig = dir === "O" ? parts[0] : parts[1] || parts[0]
    const dest = dir === "O" ? parts[1] || parts[0] : parts[0]
    addRoute(routeId, ["lrtfeeder"], orig || name, dest || name, "1", dir, "lrtfeeder", null, null, ids)
  }
}

async function pool<T>(items: T[], size: number, job: (item: T) => Promise<void>) {
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await job(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()))
}

async function getJson<T>(url: string): Promise<T> {
  const text = await getText(url)
  return JSON.parse(text) as T
}

async function getText(url: string) {
  let last = "網絡錯誤"
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,text/csv,*/*" } })
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        last = `${res.status}`
        await delay(300 * (attempt + 1))
        continue
      }
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      return await res.text()
    } catch (err) {
      last = err instanceof Error ? err.message : last
      await delay(200 * (attempt + 1))
    }
  }
  throw new Error(last)
}

function noteBlock(err: unknown, mark: () => void) {
  const message = err instanceof Error ? err.message : ""
  if (/^(403|429|500|502|503|504)\b/.test(message) || message === "網絡錯誤") mark()
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseCsv(text: string) {
  return text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","))
}
