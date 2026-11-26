export type Coordinate = [number, number];
export type Ping = {
  vehicle_id: string;
  timestamp: string;
  lat: number;
  lon: number;
  speed_kmh: number | null;
  accuracy_m: number;
};
export type Zone = {
  type: "Feature";
  properties: { zone_id: string; name: string; type: "service" | "restricted" };
  geometry: { type: "Polygon"; coordinates: Coordinate[][] };
};
export type Stop = {
  vehicle_id: string;
  date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  lat: number;
  lon: number;
  zones: string[];
  in_own_depot_area: boolean;
  restricted: boolean;
};

const EARTH_RADIUS_KM = 6371.0088;

export function haversineKm(a: Coordinate, b: Coordinate): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const [lon1, lat1] = a.map(radians);
  const [lon2, lat2] = b.map(radians);
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function pointInRing(point: Coordinate, ring: Coordinate[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = ((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInZone(point: Coordinate, zone: Zone): boolean {
  const [outer, ...holes] = zone.geometry.coordinates;
  return pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole));
}

export function detectStops(pings: Ping[], minimumMinutes = 5): Stop[] {
  const stops: Stop[] = [];
  let start = 0;
  const isStopped = (ping: Ping) => ping.speed_kmh === null || ping.speed_kmh < 5;
  const flush = (end: number) => {
    if (end <= start) return;
    const first = pings[start], last = pings[end];
    const minutes = (Date.parse(last.timestamp) - Date.parse(first.timestamp)) / 60000;
    if (minutes >= minimumMinutes) {
      stops.push({
        vehicle_id: first.vehicle_id,
        date: first.timestamp.slice(0, 10),
        start_time: first.timestamp,
        end_time: last.timestamp,
        duration_minutes: Math.round(minutes * 10) / 10,
        lat: pings.slice(start, end + 1).reduce((sum, p) => sum + p.lat, 0) / (end - start + 1),
        lon: pings.slice(start, end + 1).reduce((sum, p) => sum + p.lon, 0) / (end - start + 1),
        zones: [],
        in_own_depot_area: false,
        restricted: false
      });
    }
  };
  for (let i = 0; i < pings.length; i++) {
    if (isStopped(pings[i])) {
      if (i > 0 && !isStopped(pings[i - 1])) start = i;
    } else {
      flush(i - 1);
      start = i + 1;
    }
  }
  flush(pings.length - 1);
  return stops;
}

export function simplifyRoute(points: Coordinate[], toleranceMeters = 20): Coordinate[] {
  if (points.length <= 2) return points;
  const tolerance = toleranceMeters / 111_320;
  const keep = new Set([0, points.length - 1]);
  const simplify = (first: number, last: number) => {
    let furthest = tolerance, index = -1;
    const [x1, y1] = points[first], [x2, y2] = points[last];
    const dx = x2 - x1, dy = y2 - y1;
    for (let i = first + 1; i < last; i++) {
      const [x, y] = points[i];
      const denominator = dx * dx + dy * dy;
      const t = denominator ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / denominator)) : 0;
      const distance = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (distance > furthest) { furthest = distance; index = i; }
    }
    if (index >= 0) {
      keep.add(index);
      simplify(first, index);
      simplify(index, last);
    }
  };
  simplify(0, points.length - 1);
  return [...keep].sort((a, b) => a - b).map((index) => points[index]);
}
