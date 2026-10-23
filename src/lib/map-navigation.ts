import { useCallback, useEffect, useState } from "react"

const STORAGE_KEY = "touhou-map-nav-v1"

export type MapNavProvider = "google" | "apple" | "ask"

export type MapNavTarget = {
  name: string
  lat: number
  lng: number
}

export function getMapNavProvider(): MapNavProvider {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === "google" || value === "apple" || value === "ask") return value
  } catch {
    /* ignore */
  }
  return "google"
}

export function setMapNavProvider(provider: MapNavProvider) {
  try {
    localStorage.setItem(STORAGE_KEY, provider)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("touhou-map-nav", { detail: provider }))
}

export function useMapNavProvider() {
  const [provider, setProviderState] = useState<MapNavProvider>(() =>
    typeof window === "undefined" ? "google" : getMapNavProvider(),
  )

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<MapNavProvider>).detail
      if (detail === "google" || detail === "apple" || detail === "ask") setProviderState(detail)
      else setProviderState(getMapNavProvider())
    }
    window.addEventListener("touhou-map-nav", onChange)
    return () => window.removeEventListener("touhou-map-nav", onChange)
  }, [])

  const setProvider = useCallback((next: MapNavProvider) => {
    setMapNavProvider(next)
    setProviderState(next)
  }, [])

  return { provider, setProvider }
}

export function buildMapNavigationUrl(provider: Exclude<MapNavProvider, "ask">, target: MapNavTarget) {
  const { name, lat, lng } = target
  const label = encodeURIComponent(name)
  if (provider === "apple") {
    return `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=w&q=${label}`
  }
  if (/Android/i.test(navigator.userAgent)) {
    return `google.navigation:q=${lat},${lng}&mode=w`
  }
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return `comgooglemaps://?daddr=${lat},${lng}&directionsmode=walking`
  }
  const dest = encodeURIComponent(`${lat},${lng}`)
  const query = encodeURIComponent(name)
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=walking&query=${query}`
}

/** Opens maps without leaving a blank in-app browser tab in iOS standalone PWAs. */
export function openMapNavigationUrl(url: string) {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true

  if (standalone) {
    window.location.assign(url)
    return
  }

  const link = document.createElement("a")
  link.href = url
  link.rel = "noopener noreferrer"
  link.target = "_blank"
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export function openMapNavigation(provider: Exclude<MapNavProvider, "ask">, target: MapNavTarget) {
  openMapNavigationUrl(buildMapNavigationUrl(provider, target))
}

export const MAP_NAV_LABELS: Record<MapNavProvider, string> = {
  google: "Google 地圖",
  apple: "Apple 地圖",
  ask: "每次選擇",
}
