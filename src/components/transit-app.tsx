import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ArrowDownUp,
  Bookmark,
  BookmarkCheck,
  Clock,
  Footprints,
  LocateFixed,
  MapPin,
  Navigation,
  RefreshCw,
  Route,
  Search,
  Trash2,
} from "lucide-react"
import { loadEtas, lookupAddresses } from "@/lib/bus/api"
import { ensureNetwork, updateNetwork } from "@/lib/bus/client-network"
import { searchBuses, suggestStops } from "@/lib/bus/engine"
import {
  etaKey,
  formatEta,
  formatWalk,
  type EtaHit,
  type EtaQuery,
  type Point,
  type SearchOutput,
  type Suggestion,
  type TripResult,
} from "@/lib/bus/types"
import {
  MAP_NAV_LABELS,
  openMapNavigation,
  type MapNavProvider,
  type MapNavTarget,
  useMapNavProvider,
} from "@/lib/map-navigation"
import { useSaved, type SavedPlace, type SavedRoute, type SavedTrip } from "@/lib/saved"

const QUICK = ["中環", "銅鑼灣", "旺角", "尖沙咀", "觀塘", "沙田", "荃灣", "元朗"]
const PLACE_NAMES = ["家", "醫院", "學校", "公司"]
const RADII = [350, 500, 800] as const

type Tab = "search" | "routes" | "saved"
type Field = "origin" | "destination"

export function TransitApp() {
  const saved = useSaved()
  const mapNav = useMapNavProvider()
  const [mapPick, setMapPick] = useState<MapNavTarget | null>(null)
  const [tab, setTab] = useState<Tab>("search")
  const [originText, setOriginText] = useState("")
  const [destText, setDestText] = useState("")
  const [origin, setOrigin] = useState<Point | null>(null)
  const [dest, setDest] = useState<Point | null>(null)
  const [active, setActive] = useState<Field | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggesting, setSuggesting] = useState(false)
  const [radius, setRadius] = useState<(typeof RADII)[number]>(500)
  const [locating, setLocating] = useState(false)
  const [geoNote, setGeoNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SearchOutput | null>(null)
  const [etas, setEtas] = useState<Record<string, EtaHit[] | "loading" | "error">>({})
  const [tick, setTick] = useState(0)
  const [placeName, setPlaceName] = useState("")
  const [placeNote, setPlaceNote] = useState<string | null>(null)
  const [savingPlace, setSavingPlace] = useState(false)
  const [sourceNote, setSourceNote] = useState<string | null>(null)
  const [builtLabel, setBuiltLabel] = useState("")
  const [updating, setUpdating] = useState(false)
  const requestId = useRef(0)

  const refreshEtas = useCallback(async (queries: EtaQuery[]) => {
    const unique = dedupeQueries(queries).slice(0, 16)
    if (!unique.length) return
    setEtas((prev) => {
      const next = { ...prev }
      for (const query of unique) next[etaKey(query)] = "loading"
      return next
    })
    try {
      const res = await loadEtas({ data: { items: unique } })
      setEtas((prev) => {
        const next = { ...prev }
        for (const row of res.items) next[row.key] = row.etas
        return next
      })
    } catch {
      setEtas((prev) => {
        const next = { ...prev }
        for (const query of unique) next[etaKey(query)] = "error"
        return next
      })
    }
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    setSourceNote("正在準備路線資料…")
    void ensureNetwork()
      .then((net) => {
        if (cancelled) return
        setBuiltLabel(net.built)
        setSourceNote(null)
      })
      .catch((err) => {
        if (cancelled) return
        setSourceNote(err instanceof Error ? err.message : "路線資料下載失敗")
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!active) {
      setSuggestions([])
      return
    }
    const text = (active === "origin" ? originText : destText).trim()
    const picked = active === "origin" ? origin : dest
    if (text.length < 1 || text === "現時位置" || (picked && picked.label === text)) {
      setSuggestions([])
      setSuggesting(false)
      return
    }
    let cancelled = false
    setSuggesting(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const net = await ensureNetwork()
          if (cancelled) return
          const places = suggestStops(net, text)
          const addressy = /[0-9０-９]|號/.test(text) || /[道路街巷]/.test(text)
          let addresses: Suggestion[] = []
          if (addressy || places.length === 0) {
            const res = await lookupAddresses({ data: { q: text } })
            addresses = res.addresses
          }
          if (cancelled) return
          setSuggestions([...places, ...addresses].slice(0, 8))
        } catch (err) {
          if (cancelled) return
          setSuggestions([])
          setError(err instanceof Error ? err.message : "車站搜尋失敗，請再試一次。")
        } finally {
          if (!cancelled) setSuggesting(false)
        }
      })()
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, originText, destText, origin, dest])

  const savedEtaKey = saved.routes
    .slice(0, 12)
    .map((route) => route.id)
    .join(",")

  useEffect(() => {
    if (tab !== "saved" || !savedEtaKey) return
    void refreshEtas(saved.routes.slice(0, 12).map((route) => route.eta))
  }, [tab, savedEtaKey, refreshEtas, saved.routes])

  const resultCount = result
    ? result.directs.length + result.transfers.length + result.passing.length
    : 0
  const savedIds = useMemo(() => new Set(saved.routes.map((route) => route.resultId)), [saved.routes])

  function pickSuggestion(item: Suggestion) {
    const place = { label: item.label, lat: item.lat, lng: item.lng }
    if (active === "destination") {
      setDest(place)
      setDestText(item.label)
      setActive(null)
    } else {
      setOrigin(place)
      setOriginText(item.label)
      setActive("destination")
    }
    setSuggestions([])
    setGeoNote(null)
  }

  function applyPlace(place: SavedPlace) {
    setDest(place.point)
    setDestText(place.point.label)
    setActive(null)
    setSuggestions([])
    setError(null)
    setPlaceNote(null)
    setTab("search")
  }

  async function saveCurrentDest(name: string) {
    const trimmed = name.trim().slice(0, 12)
    if (!trimmed) return
    if (!destText.trim()) {
      setError("先輸入目的地，再記低。")
      setTab("search")
      return
    }
    setSavingPlace(true)
    setError(null)
    try {
      const point = dest && dest.label === destText.trim() ? dest : await resolveField(destText, dest)
      if (!point) {
        setError("搵唔到目的地，未能記低。")
        setTab("search")
        return
      }
      setDest(point)
      setDestText(point.label)
      saved.setPlaces((prev) => {
        const existing = prev.find((item) => item.name === trimmed)
        const next: SavedPlace = {
          id: existing?.id ?? crypto.randomUUID(),
          name: trimmed,
          point,
          savedAt: Date.now(),
        }
        return [next, ...prev.filter((item) => item.name !== trimmed)].slice(0, 12)
      })
      setPlaceName("")
      setPlaceNote(`已記低「${trimmed}」`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "未能記低目的地。")
    } finally {
      setSavingPlace(false)
    }
  }

  function fillQuick(name: string) {
    if (!originText.trim()) {
      setOriginText(name)
      setOrigin(null)
      setActive("origin")
    } else {
      setDestText(name)
      setDest(null)
      setActive("destination")
    }
  }

  function locate() {
    setGeoNote(null)
    if (!navigator.geolocation) {
      setGeoNote("這部裝置不支援定位，請輸入地名。")
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const place = { label: "現時位置", lat: pos.coords.latitude, lng: pos.coords.longitude }
        setOrigin(place)
        setOriginText("現時位置")
        setActive(null)
        setLocating(false)
      },
      (err) => {
        setLocating(false)
        setGeoNote(
          err.code === 1
            ? "未能取得位置。請在 iPhone 設定允許定位，或直接輸入車站。"
            : "定位失敗，請輸入車站或地名。",
        )
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 20000 },
    )
  }

  function swap() {
    setOrigin(dest)
    setDest(origin)
    setOriginText(destText)
    setDestText(originText)
  }

  async function resolveField(text: string, picked: Point | null) {
    const trimmed = text.trim()
    if (!trimmed) return null
    if (picked && (picked.label === trimmed || trimmed === "現時位置")) return picked
    const net = await ensureNetwork()
    const place = suggestStops(net, trimmed, 1)[0]
    if (place) return { label: place.label, lat: place.lat, lng: place.lng }
    const res = await lookupAddresses({ data: { q: trimmed } })
    const hit = res.addresses[0]
    if (!hit) return null
    return { label: hit.label, lat: hit.lat, lng: hit.lng }
  }

  async function runSearch(from: Point, to: Point | null) {
    const net = await ensureNetwork()
    setBuiltLabel(net.built)
    const found = searchBuses(net, { origin: from, destination: to, radius })
    setResult(found)
    setTab("routes")
    void refreshEtas(
      [...found.directs.slice(0, 8), ...found.transfers.slice(0, 3), ...found.passing.slice(0, 6)].flatMap(
        (trip) => trip.legs.map((leg) => leg.eta),
      ),
    )
    return found
  }

  async function submitWith(
    originValue: string,
    destValue: string,
    originPoint: Point | null,
    destPoint: Point | null,
  ) {
    const id = ++requestId.current
    setError(null)
    setLoading(true)
    setActive(null)
    try {
      const from = await resolveField(originValue, originPoint)
      if (id !== requestId.current) return
      if (!from) {
        setError("搵唔到出發地，試下選一個車站。")
        return
      }
      const destTrim = destValue.trim()
      const to = destTrim ? await resolveField(destTrim, destPoint) : null
      if (id !== requestId.current) return
      if (destTrim && !to) {
        setError("搵唔到目的地。可留空，只看途經路線。")
        return
      }
      setOrigin(from)
      setOriginText(from.label)
      setDest(to)
      if (to) setDestText(to.label)
      await runSearch(from, to)
    } catch (err) {
      if (id !== requestId.current) return
      setError(err instanceof Error ? err.message : "搜尋失敗，請再試一次。")
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }

  function submit() {
    return submitWith(originText, destText, origin, dest)
  }

  function toggleRoute(trip: TripResult) {
    const leg = trip.legs[0]
    if (!leg) return
    saved.setRoutes((prev) => {
      if (prev.some((item) => item.resultId === trip.id)) {
        return prev.filter((item) => item.resultId !== trip.id)
      }
      const end = trip.legs[trip.legs.length - 1]
      const subtitle = trip.legs[1]
        ? `${leg.companyLabel} · 轉 ${trip.legs[1].routeNo} · ${leg.boardName}`
        : trip.kind === "passing"
          ? `${leg.companyLabel} · 往${leg.dest} · ${leg.boardName}`
          : `${leg.companyLabel} · ${leg.boardName} → ${end?.alightName ?? leg.dest}`
      const next: SavedRoute = {
        id: crypto.randomUUID(),
        resultId: trip.id,
        title: leg.routeNo,
        subtitle,
        eta: leg.eta,
        savedAt: Date.now(),
      }
      return [next, ...prev].slice(0, 30)
    })
  }

  function saveTrip() {
    if (!origin || !dest) return
    saved.setTrips((prev) => {
      const exists = prev.find((trip) => samePoint(trip.origin, origin) && samePoint(trip.destination, dest))
      const next: SavedTrip = {
        id: exists?.id ?? crypto.randomUUID(),
        origin,
        destination: dest,
        savedAt: Date.now(),
      }
      return [next, ...prev.filter((trip) => trip.id !== next.id)].slice(0, 20)
    })
  }

  function openTrip(trip: SavedTrip) {
    setOrigin(trip.origin)
    setDest(trip.destination)
    setOriginText(trip.origin.label)
    setDestText(trip.destination.label)
    setError(null)
    setLoading(true)
    void runSearch(trip.origin, trip.destination)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "搜尋失敗")
        setTab("search")
      })
      .finally(() => setLoading(false))
  }

  function requestMapNavigation(target: MapNavTarget) {
    if (mapNav.provider === "ask") {
      setMapPick(target)
      return
    }
    openMapNavigation(mapNav.provider, target)
  }

  function confirmMapPick(choice: Exclude<MapNavProvider, "ask">, remember: boolean) {
    if (!mapPick) return
    if (remember) mapNav.setProvider(choice)
    openMapNavigation(choice, mapPick)
    setMapPick(null)
  }

  async function updateRoutes() {
    setUpdating(true)
    setSourceNote("正在向巴士公司更新路線，可能要幾分鐘。")
    setError(null)
    try {
      const report = await updateNetwork((message) => setSourceNote(message))
      setBuiltLabel(report.built)
      setSourceNote(
        report.kept.length
          ? `已更新${report.updated.join("、")}。${report.kept.join("、")}暫時連不上，仍用原本的路線。`
          : `路線資料已更新至 ${report.built}。`,
      )
    } catch (err) {
      setSourceNote(err instanceof Error ? err.message : "更新失敗，仍用手機裡的路線資料。")
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col">
        <header className="px-4 pt-safe">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="font-display text-4xl font-semibold leading-none tracking-tight text-primary">途號</p>
              <p className="mt-2 text-sm text-muted">由位置找出可搭、或途經的香港巴士</p>
            </div>
            <img
              src="/icon-192.png"
              alt=""
              width={48}
              height={48}
              className="mb-1 size-12 rounded-2xl"
            />
          </div>
          {tab === "search" && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-muted">路線資料 {builtLabel || "下載中"}</p>
              <button
                type="button"
                className="h-11 shrink-0 text-sm text-primary disabled:opacity-50"
                disabled={updating}
                onClick={() => void updateRoutes()}
              >
                {updating ? "更新中…" : "更新路線資料"}
              </button>
            </div>
          )}
          {sourceNote ? <p className="mt-1 text-sm text-muted">{sourceNote}</p> : null}
        </header>

        <main className="flex-1 px-4 pb-nav pt-5">
          {tab === "search" && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <div className="rounded-card border border-line bg-surface p-3">
                <PlaceField
                  label="出發"
                  placeholder="現時位置，或輸入車站"
                  value={originText}
                  active={active === "origin"}
                  onFocus={() => setActive("origin")}
                  onChange={(value) => {
                    setOriginText(value)
                    setOrigin(null)
                    setActive("origin")
                  }}
                  action={
                    <button
                      type="button"
                      className="inline-flex h-11 min-w-11 items-center justify-center rounded-xl bg-raised px-3 text-primary"
                      onClick={locate}
                      disabled={locating}
                      aria-label="使用現時位置"
                    >
                      <LocateFixed className="size-5" />
                    </button>
                  }
                />
                {active === "origin" && (
                  <SuggestionList items={suggestions} pending={suggesting} onPick={pickSuggestion} />
                )}
                <div className="flex justify-center py-1">
                  <button
                    type="button"
                    className="inline-flex h-11 items-center gap-2 rounded-full px-4 text-sm text-muted"
                    onClick={swap}
                    aria-label="對調起點和終點"
                  >
                    <ArrowDownUp className="size-4" />
                    對調
                  </button>
                </div>
                <PlaceField
                  label="目的地"
                  placeholder="輸入車站，例如旺角"
                  value={destText}
                  active={active === "destination"}
                  onFocus={() => setActive("destination")}
                  onChange={(value) => {
                    setDestText(value)
                    setDest(null)
                    setActive("destination")
                  }}
                  action={
                    destText.trim() ? (
                      <button
                        type="button"
                        className="h-11 shrink-0 rounded-xl px-3 text-sm text-primary"
                        onClick={() => setTab("saved")}
                      >
                        記低
                      </button>
                    ) : null
                  }
                />
                {active === "destination" && (
                  <SuggestionList items={suggestions} pending={suggesting} onPick={pickSuggestion} />
                )}
                {error && (
                  <p role="alert" className="mt-2 rounded-xl bg-raised px-3 py-3 text-sm text-fg">
                    {error}
                  </p>
                )}
              </div>

              {geoNote && <p className="text-sm text-muted">{geoNote}</p>}
              {placeNote ? <p className="text-sm text-primary">{placeNote}</p> : null}

              {saved.places.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {saved.places.map((place) => (
                    <button
                      key={place.id}
                      type="button"
                      className="h-11 max-w-full truncate rounded-full border border-line bg-surface px-4 text-sm"
                      onClick={() => applyPlace(place)}
                      aria-label={`目的地 ${place.name}，${place.point.label}`}
                    >
                      {place.name}
                    </button>
                  ))}
                </div>
              )}

              <button
                type="submit"
                className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-30 h-12 w-full rounded-xl bg-primary text-base font-medium text-primary-fg shadow-lg disabled:opacity-50"
                disabled={loading}
              >
                {loading ? "搜尋中…" : destText.trim() ? "搜尋可達路線" : "查看途經路線"}
              </button>

              <div className="flex items-center gap-1 px-1">
                <span className="text-sm text-muted">範圍</span>
                {RADII.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={
                      value === radius
                        ? "h-11 px-2 text-sm font-medium text-primary"
                        : "h-11 px-2 text-sm text-muted"
                    }
                    onClick={() => setRadius(value)}
                    aria-pressed={value === radius}
                  >
                    {value} 米
                  </button>
                ))}
              </div>

              <div>
                <p className="mb-2 text-sm text-muted">常用地名</p>
                <div className="flex flex-wrap gap-2">
                  {QUICK.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="h-11 rounded-full border border-line bg-surface px-4 text-sm"
                      onClick={() => fillQuick(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            </form>
          )}

          {tab === "routes" && (
            <section className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h1 className="text-lg font-medium">
                    {result && dest
                      ? `${origin?.label ?? "出發"} → ${dest.label}`
                      : origin?.label
                        ? `途經 ${origin.label}`
                        : "路線"}
                  </h1>
                  {result?.straightM ? (
                    <p className="mt-1 text-sm text-muted">直線約 {Math.round(result.straightM / 100) / 10} 公里</p>
                  ) : null}
                </div>
                {origin && dest && (
                  <button type="button" className="h-11 shrink-0 rounded-xl border border-line px-3 text-sm" onClick={saveTrip}>
                    儲存行程
                  </button>
                )}
              </div>
              {result?.note && (
                <p className="rounded-xl border border-line bg-surface px-3 py-3 text-sm text-muted">{result.note}</p>
              )}
              {loading && <p className="text-sm text-muted">搜尋中…</p>}
              {!loading && !result && (
                <div className="rounded-card border border-line bg-surface px-4 py-8 text-center">
                  <p className="text-base">尚未搜尋</p>
                  <p className="mt-2 text-sm text-muted">先輸入出發地，或者再加目的地。</p>
                </div>
              )}
              {!loading && result && resultCount === 0 && (
                <div className="rounded-card border border-line bg-surface px-4 py-8 text-center">
                  <p className="text-base">未找到符合的巴士</p>
                  <p className="mt-2 text-sm text-muted">試下放大範圍，或改選更接近馬路的車站。</p>
                </div>
              )}
              <TripList
                title="直達"
                trips={result?.directs ?? []}
                etas={etas}
                tick={tick}
                savedIds={savedIds}
                onToggle={toggleRoute}
                onNavigate={requestMapNavigation}
              />
              <TripList
                title="轉一次車"
                trips={result?.transfers ?? []}
                etas={etas}
                tick={tick}
                savedIds={savedIds}
                onToggle={toggleRoute}
                onNavigate={requestMapNavigation}
              />
              <TripList
                title={result?.directs.length || result?.transfers.length ? "途經出發地" : "途經路線"}
                trips={result?.passing ?? []}
                etas={etas}
                tick={tick}
                savedIds={savedIds}
                onToggle={toggleRoute}
                onNavigate={requestMapNavigation}
              />
              {result && resultCount > 0 && (
                <button
                  type="button"
                  className="inline-flex h-11 items-center gap-2 text-sm text-primary"
                  onClick={() =>
                    void refreshEtas([...result.directs, ...result.transfers, ...result.passing].flatMap((trip) => trip.legs.map((leg) => leg.eta)))
                  }
                >
                  <RefreshCw className="size-4" />
                  更新到站時間
                </button>
              )}
            </section>
          )}

          {tab === "saved" && (
            <section className="space-y-6">
              <div>
                <h1 className="text-lg font-medium">常用目的地</h1>
                <p className="mt-2 text-sm text-muted">家、醫院、學校這類地點只存在這部電話。撳一下會填入目的地。</p>
                {destText.trim() ? (
                  <div className="mt-3 rounded-card border border-line bg-surface p-3">
                    <p className="truncate text-sm">現時目的地：{dest?.label || destText}</p>
                    <div className="mt-3">
                      <PlaceNameButtons disabled={savingPlace} onPick={(name) => void saveCurrentDest(name)} />
                    </div>
                    <div className="mt-3 flex gap-2">
                      <input
                        value={placeName}
                        onChange={(event) => setPlaceName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return
                          event.preventDefault()
                          void saveCurrentDest(placeName)
                        }}
                        placeholder="自訂名稱，例如診所"
                        maxLength={12}
                        className="h-11 min-w-0 flex-1 rounded-xl bg-raised px-3 text-base text-fg outline-none placeholder:text-muted"
                      />
                      <button
                        type="button"
                        className="h-11 shrink-0 rounded-xl bg-primary px-4 text-sm font-medium text-primary-fg disabled:opacity-50"
                        disabled={savingPlace || !placeName.trim()}
                        onClick={() => void saveCurrentDest(placeName)}
                      >
                        儲存
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted">先在搜尋頁輸入目的地，再在這裡記低名稱。</p>
                )}
                {placeNote ? <p className="mt-2 text-sm text-primary">{placeNote}</p> : null}
                {saved.places.length > 0 && (
                  <ul className="mt-3 space-y-2">
                    {saved.places.map((place) => (
                      <li key={place.id} className="flex items-center gap-2 rounded-card border border-line bg-surface p-3">
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => applyPlace(place)}>
                          <span className="block truncate text-base">{place.name}</span>
                          <span className="block truncate text-sm text-muted">{place.point.label}</span>
                        </button>
                        <button
                          type="button"
                          className="inline-flex size-11 items-center justify-center text-muted"
                          aria-label={`刪除${place.name}`}
                          onClick={() => saved.setPlaces((prev) => prev.filter((item) => item.id !== place.id))}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h2 className="text-lg font-medium">常用行程</h2>
                {saved.trips.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">搜尋後可以儲存「家 → 公司」這類行程，之後一按再查。</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {saved.trips.map((trip) => (
                      <li key={trip.id} className="flex items-center gap-2 rounded-card border border-line bg-surface p-3">
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openTrip(trip)}>
                          <span className="block truncate text-base">{trip.origin.label}</span>
                          <span className="block truncate text-sm text-muted">往 {trip.destination.label}</span>
                        </button>
                        <button
                          type="button"
                          className="inline-flex size-11 items-center justify-center text-muted"
                          aria-label="刪除行程"
                          onClick={() => saved.setTrips((prev) => prev.filter((item) => item.id !== trip.id))}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h2 className="text-lg font-medium">收藏路線</h2>
                {saved.routes.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">在路線結果按書籤，就會留低到站時間。</p>
                ) : (
                  <ul className="mt-3 space-y-3">
                    {saved.routes.map((route) => (
                      <li key={route.id} className="rounded-card border border-line bg-surface p-3">
                        <div className="flex items-start gap-3">
                          <div className="blind flex h-16 w-20 shrink-0 flex-col items-center justify-center">
                            <span className="font-display text-3xl font-semibold leading-none">{route.title}</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm leading-snug">{route.subtitle}</p>
                            <EtaLine eta={etas[etaKey(route.eta)]} tick={tick} />
                          </div>
                          <button
                            type="button"
                            className="inline-flex size-11 items-center justify-center text-muted"
                            aria-label="取消收藏"
                            onClick={() => saved.setRoutes((prev) => prev.filter((item) => item.id !== route.id))}
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <MapNavSettings provider={mapNav.provider} onChange={mapNav.setProvider} />
            </section>
          )}
        </main>

        {mapPick ? (
          <MapNavPicker
            target={mapPick}
            onCancel={() => setMapPick(null)}
            onChoose={(choice, remember) => confirmMapPick(choice, remember)}
          />
        ) : null}

        <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-safe">
          <div className="mx-auto grid max-w-lg grid-cols-3">
            <TabButton current={tab} id="search" label="搜尋" icon={<Search className="size-5" />} onSelect={setTab} />
            <TabButton current={tab} id="routes" label="路線" icon={<Route className="size-5" />} badge={resultCount || undefined} onSelect={setTab} />
            <TabButton
              current={tab}
              id="saved"
              label="收藏"
              icon={<Bookmark className="size-5" />}
              badge={saved.routes.length + saved.trips.length + saved.places.length || undefined}
              onSelect={setTab}
            />
          </div>
        </nav>
      </div>
    </div>
  )
}

function SuggestionList({
  items,
  pending,
  onPick,
}: {
  items: Suggestion[]
  pending: boolean
  onPick: (item: Suggestion) => void
}) {
  if (!pending && items.length === 0) return null
  return (
    <ul className="mt-2 max-h-60 overflow-auto rounded-xl border border-line bg-raised">
      {pending && items.length === 0 && <li className="px-3 py-3 text-sm text-muted">搜尋車站…</li>}
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}-${item.label}`}>
          <button
            type="button"
            className="flex min-h-11 w-full items-start gap-3 px-3 py-3 text-left"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onPick(item)}
          >
            <MapPin className="mt-0.5 size-4 shrink-0 text-primary" />
            <span className="min-w-0">
              <span className="block truncate text-base text-fg">{item.label}</span>
              <span className="block truncate text-sm text-muted">{item.detail}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function MapNavSettings({
  provider,
  onChange,
}: {
  provider: MapNavProvider
  onChange: (provider: MapNavProvider) => void
}) {
  const options: MapNavProvider[] = ["google", "apple", "ask"]
  return (
    <div className="rounded-card border border-line bg-surface p-3">
      <h2 className="text-lg font-medium">地圖導航</h2>
      <p className="mt-1 text-sm text-muted">撳「導航到車站」時用哪個地圖 App。預設為 Google 地圖。</p>
      <div className="mt-3 flex flex-col gap-2">
        {options.map((id) => (
          <button
            key={id}
            type="button"
            className={
              id === provider
                ? "flex h-11 items-center justify-between rounded-xl bg-raised px-3 text-sm text-primary"
                : "flex h-11 items-center justify-between rounded-xl border border-line px-3 text-sm text-fg"
            }
            aria-pressed={id === provider}
            onClick={() => onChange(id)}
          >
            <span>{MAP_NAV_LABELS[id]}</span>
            {id === provider ? <span className="text-xs">已選</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function MapNavPicker({
  target,
  onCancel,
  onChoose,
}: {
  target: MapNavTarget
  onCancel: () => void
  onChoose: (choice: Exclude<MapNavProvider, "ask">, remember: boolean) => void
}) {
  const [remember, setRemember] = useState(true)
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 pb-nav" role="dialog" aria-modal="true" aria-labelledby="map-nav-title">
      <div className="w-full max-w-lg rounded-card border border-line bg-surface p-4 shadow-xl">
        <h2 id="map-nav-title" className="text-lg font-medium">選擇地圖</h2>
        <p className="mt-1 truncate text-sm text-muted">導航到 {target.name}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            className="h-12 rounded-xl bg-primary text-sm font-medium text-primary-fg"
            onClick={() => onChoose("google", remember)}
          >
            Google 地圖
          </button>
          <button
            type="button"
            className="h-12 rounded-xl border border-line bg-raised text-sm font-medium"
            onClick={() => onChoose("apple", remember)}
          >
            Apple 地圖
          </button>
        </div>
        <label className="mt-4 flex min-h-11 items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            className="size-4 accent-[var(--color-primary)]"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          記住選擇，下次自動開啟
        </label>
        <button type="button" className="mt-2 h-11 w-full text-sm text-muted" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}

function PlaceNameButtons({ disabled, onPick }: { disabled: boolean; onPick: (name: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {PLACE_NAMES.map((name) => (
        <button
          key={name}
          type="button"
          className="h-11 rounded-full border border-line bg-surface px-4 text-sm disabled:opacity-50"
          disabled={disabled}
          onClick={() => onPick(name)}
        >
          {name}
        </button>
      ))}
    </div>
  )
}

function PlaceField({
  label,
  placeholder,
  value,
  active,
  onFocus,
  onChange,
  action,
}: {
  label: string
  placeholder: string
  value: string
  active: boolean
  onFocus: () => void
  onChange: (value: string) => void
  action?: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block px-1 text-xs tracking-wide text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <input
          value={value}
          placeholder={placeholder}
          onFocus={onFocus}
          onChange={(event) => onChange(event.target.value)}
          aria-expanded={active}
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="search"
          suppressHydrationWarning
          className="h-12 min-w-0 flex-1 rounded-xl bg-raised px-3 text-base text-fg outline-none placeholder:text-muted focus:ring-2 focus:ring-primary"
        />
        {action}
      </span>
    </label>
  )
}

function TabButton({
  current,
  id,
  label,
  icon,
  badge,
  onSelect,
}: {
  current: Tab
  id: Tab
  label: string
  icon: ReactNode
  badge?: number
  onSelect: (tab: Tab) => void
}) {
  const on = current === id
  return (
    <button
      type="button"
      className={
        on
          ? "flex h-14 flex-col items-center justify-center gap-0.5 text-primary"
          : "flex h-14 flex-col items-center justify-center gap-0.5 text-muted"
      }
      onClick={() => onSelect(id)}
      aria-current={on ? "page" : undefined}
    >
      <span className="relative">
        {icon}
        {badge ? (
          <span className="absolute -top-2 left-3 rounded-full bg-primary px-1 text-xs font-medium leading-4 text-primary-fg">
            {badge > 9 ? "9+" : badge}
          </span>
        ) : null}
      </span>
      <span className="text-xs">{label}</span>
    </button>
  )
}

function TripList({
  title,
  trips,
  etas,
  tick,
  savedIds,
  onToggle,
  onNavigate,
}: {
  title: string
  trips: TripResult[]
  etas: Record<string, EtaHit[] | "loading" | "error">
  tick: number
  savedIds: Set<string>
  onToggle: (trip: TripResult) => void
  onNavigate: (target: MapNavTarget) => void
}) {
  if (!trips.length) return null
  return (
    <div className="space-y-3">
      <h2 className="text-sm text-muted">{title}</h2>
      {trips.map((trip) => (
        <TripCard
          key={trip.id}
          trip={trip}
          etas={etas}
          tick={tick}
          saved={savedIds.has(trip.id)}
          onToggle={() => onToggle(trip)}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  )
}

function TripCard({
  trip,
  etas,
  tick,
  saved,
  onToggle,
  onNavigate,
}: {
  trip: TripResult
  etas: Record<string, EtaHit[] | "loading" | "error">
  tick: number
  saved: boolean
  onToggle: () => void
  onNavigate: (target: MapNavTarget) => void
}) {
  const first = trip.legs[0]
  if (!first) return null
  const second = trip.legs[1]
  return (
    <article className="rounded-card border border-line bg-surface p-3">
      <div className="flex gap-3">
        <div className="blind flex w-20 shrink-0 flex-col items-center justify-center px-1 py-3">
          <span className="font-display text-4xl font-semibold leading-none">{first.routeNo}</span>
          <span className="mt-1 text-center text-xs text-muted">{first.companyLabel}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            {first.orig} → {first.dest}
          </p>
          <p className="mt-1 flex items-center gap-1 text-sm text-muted">
            <Footprints className="size-4 shrink-0" />
            <span className="truncate">
              上 {first.boardName} · {formatWalk(first.boardWalkM)}
            </span>
          </p>
          {Number.isFinite(first.boardLat) && (
            <button
              type="button"
              className="mt-1 inline-flex h-11 items-center gap-2 text-sm text-primary"
              onClick={() =>
                onNavigate({ name: first.boardName, lat: first.boardLat, lng: first.boardLng })
              }
            >
              <Navigation className="size-4" />
              導航到車站
            </button>
          )}
          {first.alightName && (
            <p className="mt-0.5 truncate text-sm text-muted">
              落 {first.alightName}
              {first.alightWalkM !== null ? ` · ${formatWalk(first.alightWalkM)}` : ""}
              {first.stopsBetween !== null ? ` · ${first.stopsBetween} 個站` : ""}
              {first.estMin ? ` · 約 ${first.estMin} 分鐘` : ""}
            </p>
          )}
          {!first.alightName && <p className="mt-0.5 text-sm text-muted">可在此上車，往 {first.dest}</p>}
          <div className="mt-1 flex flex-wrap gap-1">
            {first.night && <Tag>通宵</Tag>}
            {first.special && <Tag>特別班</Tag>}
          </div>
          <EtaLine eta={etas[etaKey(first.eta)]} tick={tick} />
        </div>
        <button
          type="button"
          className="inline-flex size-11 shrink-0 items-center justify-center text-primary"
          aria-label={saved ? "取消收藏" : "收藏路線"}
          aria-pressed={saved}
          onClick={onToggle}
        >
          {saved ? <BookmarkCheck className="size-5" /> : <Bookmark className="size-5" />}
        </button>
      </div>
      {second && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="mb-2 text-xs text-muted">轉車 · {trip.transferName}</p>
          <div className="flex gap-3">
            <div className="blind flex w-20 shrink-0 flex-col items-center justify-center px-1 py-2">
              <span className="font-display text-3xl font-semibold leading-none">{second.routeNo}</span>
              <span className="mt-1 text-xs text-muted">{second.companyLabel}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {second.orig} → {second.dest}
              </p>
              <p className="mt-1 truncate text-sm text-muted">
                落到 {second.alightName}
                {second.stopsBetween !== null ? ` · ${second.stopsBetween} 個站` : ""}
              </p>
              <EtaLine eta={etas[etaKey(second.eta)]} tick={tick} />
            </div>
          </div>
        </div>
      )}
    </article>
  )
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-primary">{children}</span>
}

function EtaLine({ eta, tick }: { eta: EtaHit[] | "loading" | "error" | undefined; tick: number }) {
  void tick
  if (eta === "loading") {
    return (
      <p className="mt-2 inline-flex items-center gap-1 text-sm text-muted">
        <Clock className="size-4" />
        到站時間查詢中
      </p>
    )
  }
  if (!eta) return null
  if (eta === "error") return <p className="mt-2 text-sm text-muted">到站時間暫時無法取得</p>
  if (!eta.length) return <p className="mt-2 text-sm text-muted">暫時沒有班次</p>
  const remark = eta.find((item) => item.remark)?.remark
  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-2">
        {eta.map((item) => (
          <span key={item.epoch} className="rounded-full bg-bg px-3 py-1 text-sm text-primary">
            {formatEta(item.epoch)}
          </span>
        ))}
      </div>
      {remark ? <p className="mt-1 text-xs text-muted">{remark}</p> : null}
    </div>
  )
}

function dedupeQueries(queries: EtaQuery[]) {
  const seen = new Set<string>()
  const out: EtaQuery[] = []
  for (const query of queries) {
    const key = etaKey(query)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(query)
  }
  return out
}

function samePoint(a: Point, b: Point) {
  return Math.abs(a.lat - b.lat) < 0.0004 && Math.abs(a.lng - b.lng) < 0.0004
}
