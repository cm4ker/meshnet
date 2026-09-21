import { AdvType } from "@meshnet/meshcore";

/** A node that has not set a position advertises 0, 0; nobody's radio sits there. */
export function hasPosition(lat: number, lon: number): boolean {
  return (lat !== 0 || lon !== 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

const EARTH_KM = 6371.0088;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance, km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from the first point to the second, degrees clockwise from north. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function compass(deg: number): string {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8]!;
}

export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export type Freshness = "fresh" | "aging" | "stale";

/**
 * How recent a node's last advert is. Repeaters advertise every few hours on
 * their own, so they are held to a longer clock than people and rooms.
 */
export function freshness(type: number, advertAgeSec: number): Freshness {
  const [fresh, day] = type === AdvType.Repeater ? [6 * 3600, 48 * 3600] : [3600, 24 * 3600];
  if (advertAgeSec <= fresh) return "fresh";
  return advertAgeSec <= day ? "aging" : "stale";
}
