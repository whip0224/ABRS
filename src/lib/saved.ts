import { useEffect, useState } from "react"
import type { EtaQuery, Point } from "./bus/types"

const KEY = "touhou-saved-v1"

export type SavedTrip = {
  id: string
  origin: Point
  destination: Point
  savedAt: number
}

export type SavedRoute = {
  id: string
  resultId: string
  title: string
  subtitle: string
  eta: EtaQuery
  savedAt: number
}

export type SavedPlace = {
  id: string
  name: string
  point: Point
  savedAt: number
}

export function useSaved() {
  const [trips, setTrips] = useState<SavedTrip[]>([])
  const [routes, setRoutes] = useState<SavedRoute[]>([])
  const [places, setPlaces] = useState<SavedPlace[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) {
        const data = JSON.parse(raw) as { trips?: SavedTrip[]; routes?: SavedRoute[]; places?: SavedPlace[] }
        if (Array.isArray(data.trips)) setTrips(data.trips.slice(0, 20))
        if (Array.isArray(data.routes)) setRoutes(data.routes.slice(0, 30))
        if (Array.isArray(data.places)) setPlaces(data.places.filter(isPlace).slice(0, 12))
      }
    } catch {
      /* ignore broken local data */
    }
    setReady(true)
  }, [])

  useEffect(() => {
    if (!ready) return
    localStorage.setItem(KEY, JSON.stringify({ trips, routes, places }))
  }, [trips, routes, places, ready])

  return { trips, routes, places, setTrips, setRoutes, setPlaces, ready }
}

function isPlace(value: SavedPlace) {
  return Boolean(
    value &&
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      value.name.trim() &&
      value.point &&
      typeof value.point.lat === "number" &&
      typeof value.point.lng === "number" &&
      typeof value.point.label === "string",
  )
}
