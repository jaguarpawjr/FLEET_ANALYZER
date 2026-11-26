import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { detectStops, haversineKm, pointInRing, pointInZone, simplifyRoute, type Ping, type Stop, type Zone } from "./core.js";

type Vehicle = { vehicle_id: string; plate: string; depot: string; depot_lat: number; depot_lon: number };
type Anomaly = { type: string; vehicle_id: string; timestamp: string; reason: string; action: string; source_row?: string };
type FeatureCollection = { type: "FeatureCollection"; features: unknown[] };
type Summary = {
  vehicle_id: string; date: string; distance_km: number; moving_minutes: number; stopped_minutes: number;
  stop_count: number; highest_believable_speed_kmh: number | null; data_quality_issues: number;
  restricted_minutes: Record<string, number>;
};
type InputFiles = { pings?: string; vehicles?: string; zones?: string };

export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted && char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function stringifyCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const quote = (value: unknown) => {
    const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))].join("\n") + "\n";
}

function inGhanaBounds(lat: number, lon: number): boolean {
  return lat >= 4 && lat <= 12 && lon >= -4 && lon <= 2;
}

function validRing(ring: [number, number][]): boolean {
  const area = ring.slice(0, -1).reduce((sum, point, i) => {
    const next = ring[i + 1];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0);
  if (Math.abs(area) < 1e-12) return false;
  const cross = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const intersects = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) =>
    cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
  const edges = ring.length - 1;
  for (let i = 0; i < edges; i++) for (let j = i + 1; j < edges; j++) {
    if (j === i + 1 || (i === 0 && j === edges - 1)) continue;
    if (intersects(ring[i], ring[i + 1], ring[j], ring[j + 1])) return false;
  }
  return true;
}

function repairZones(input: FeatureCollection, anomalies: Anomaly[]): Zone[] {
  return input.features.flatMap((raw: any) => {
    const geometry = raw.geometry;
    const properties = raw.properties ?? {};
    if (geometry?.type !== "Polygon" || !Array.isArray(geometry.coordinates) || !geometry.coordinates[0]?.length) {
      anomalies.push({ type: "invalid_zone_geometry", vehicle_id: "", timestamp: "", reason: `${properties.zone_id ?? "unknown"} is not a usable Polygon`, action: "dropped", source_row: JSON.stringify(raw) });
      return [];
    }
    let changed = false;
    const coordinates = geometry.coordinates.map((ring: [number, number][]) => {
      const clean = ring.filter((p) => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);
      if (clean.length !== ring.length) changed = true;
      if (clean.length && (clean[0][0] !== clean.at(-1)![0] || clean[0][1] !== clean.at(-1)![1])) { clean.push([...clean[0]]); changed = true; }
      return clean;
    }).filter((ring: [number, number][]) => ring.length >= 4);
    if (coordinates.length !== geometry.coordinates.length || !coordinates.length) {
      anomalies.push({ type: "invalid_zone_geometry", vehicle_id: "", timestamp: "", reason: `${properties.zone_id ?? "unknown"} has an invalid coordinate ring`, action: "dropped", source_row: JSON.stringify(raw) });
      return [];
    }
    if (changed) anomalies.push({ type: "zone_ring_repaired", vehicle_id: "", timestamp: "", reason: `${properties.zone_id ?? "unknown"} rings were closed and invalid positions removed`, action: "repaired", source_row: JSON.stringify(raw) });
    if (coordinates.some((ring: [number, number][]) => !validRing(ring)) ||
        coordinates.slice(1).some((ring: [number, number][]) => !pointInRing(ring[0], coordinates[0]))) {
      anomalies.push({ type: "invalid_zone_geometry", vehicle_id: "", timestamp: "", reason: `${properties.zone_id ?? "unknown"} has a self-intersecting, zero-area, or out-of-shell ring`, action: "dropped", source_row: JSON.stringify(raw) });
      return [];
    }
    if (!["service", "restricted"].includes(properties.type)) {
      anomalies.push({ type: "invalid_zone_type", vehicle_id: "", timestamp: "", reason: `${properties.zone_id ?? "unknown"} has unknown zone type`, action: "dropped", source_row: JSON.stringify(raw) });
      return [];
    }
    return [{
      type: "Feature" as const,
      properties: { zone_id: String(properties.zone_id ?? "zone"), name: String(properties.name ?? properties.zone_id ?? "Zone"), type: properties.type },
      geometry: { type: "Polygon" as const, coordinates }
    }];
  });
}

export async function runPipeline(
  inputDir = "data/raw",
  outputDir = "data/processed",
  files: InputFiles = {}
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const [pingText, vehicleText, rawZones] = await Promise.all([
    readFile(join(inputDir, files.pings ?? "pings.csv"), "utf8"),
    readFile(join(inputDir, files.vehicles ?? "vehicles.csv"), "utf8"),
    readFile(join(inputDir, files.zones ?? "zones.geojson"), "utf8")
  ]);
  const [pingHeaders, ...pingRows] = parseCsv(pingText);
  const [vehicleHeaders, ...vehicleRows] = parseCsv(vehicleText);
  const anomalies: Anomaly[] = [];
  const processingDates = new Set<string>();
  const vehicles = new Map<string, Vehicle>();
  const registerRows = new Map<string, Vehicle[]>();
  for (const cells of vehicleRows) {
    const v = Object.fromEntries(vehicleHeaders.map((header, i) => [header, cells[i]?.trim() ?? ""])) as Record<string, string>;
    const vehicle: Vehicle = { vehicle_id: v.vehicle_id, plate: v.plate, depot: v.depot, depot_lat: Number(v.depot_lat), depot_lon: Number(v.depot_lon) };
    const records = registerRows.get(vehicle.vehicle_id) ?? [];
    records.push(vehicle);
    registerRows.set(vehicle.vehicle_id, records);
  }
  for (const [vehicleId, records] of registerRows) {
    const validRecords = records.filter((record) => inGhanaBounds(record.depot_lat, record.depot_lon));
    if (records.length > 1) {
      anomalies.push({
        type: "register_id_conflict", vehicle_id: vehicleId, timestamp: "",
        reason: "Multiple register rows share this ID; plate and depot attribution withheld",
        action: "flagged", source_row: JSON.stringify(records)
      });
      if (validRecords.length) {
        vehicles.set(vehicleId, { vehicle_id: vehicleId, plate: "", depot: "", depot_lat: NaN, depot_lon: NaN });
      }
    } else if (validRecords.length === 1) {
      vehicles.set(vehicleId, validRecords[0]);
    } else {
      anomalies.push({ type: "invalid_vehicle_record", vehicle_id: vehicleId, timestamp: "", reason: "Missing vehicle ID or depot coordinates outside Ghana", action: "dropped", source_row: JSON.stringify(records[0]) });
    }
  }
  const zones = repairZones(JSON.parse(rawZones), anomalies);
  const seen = new Set<string>();
  const byVehicle = new Map<string, Ping[]>();
  const qualityCounts = new Map<string, number>();
  for (const cells of pingRows) {
    const source = Object.fromEntries(pingHeaders.map((header, i) => [header, cells[i]?.trim() ?? ""])) as Record<string, string>;
    const vehicleId = source.vehicle_id;
    const timestamp = Date.parse(source.timestamp);
    if (Number.isFinite(timestamp)) processingDates.add(new Date(timestamp).toISOString().slice(0, 10));
    const rowKey = JSON.stringify(source);
    const reject = (type: string, reason: string) => {
      anomalies.push({ type, vehicle_id: vehicleId, timestamp: source.timestamp, reason, action: "dropped", source_row: JSON.stringify(source) });
      qualityCounts.set(vehicleId, (qualityCounts.get(vehicleId) ?? 0) + 1);
    };
    if (!vehicles.has(vehicleId)) { reject("unknown_vehicle", "Tracker ID is not in vehicles.csv"); continue; }
    if (!Number.isFinite(timestamp)) { reject("invalid_timestamp", "Timestamp cannot be parsed"); continue; }
    const lat = Number(source.lat), lon = Number(source.lon), accuracy = Number(source.accuracy_m);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inGhanaBounds(lat, lon)) { reject("invalid_coordinates", "Coordinates are outside Ghana or not numeric"); continue; }
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100) { reject("poor_accuracy", "Accuracy is missing, negative, or exceeds 100 m"); continue; }
    if (seen.has(rowKey)) { reject("duplicate_ping", "Exact duplicate source row"); continue; }
    seen.add(rowKey);
    let speed = Number(source.speed_kmh);
    if (!Number.isFinite(speed) || speed < 0 || speed > 160) {
      anomalies.push({ type: "implausible_speed", vehicle_id: vehicleId, timestamp: source.timestamp, reason: "Speed outside 0-160 km/h; retained ping with speed marked unknown", action: "changed", source_row: JSON.stringify(source) });
      qualityCounts.set(vehicleId, (qualityCounts.get(vehicleId) ?? 0) + 1);
      speed = NaN;
    }
    const normalizedTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(source.timestamp) ? source.timestamp : new Date(timestamp).toISOString();
    if (normalizedTimestamp !== source.timestamp) {
      anomalies.push({ type: "timestamp_normalized", vehicle_id: vehicleId, timestamp: source.timestamp, reason: "Timestamp normalized to UTC ISO-8601", action: "changed", source_row: JSON.stringify(source) });
      qualityCounts.set(vehicleId, (qualityCounts.get(vehicleId) ?? 0) + 1);
    }
    const ping: Ping = { vehicle_id: vehicleId, timestamp: normalizedTimestamp, lat, lon, speed_kmh: Number.isFinite(speed) ? speed : null, accuracy_m: accuracy };
    const list = byVehicle.get(vehicleId) ?? [];
    list.push(ping); byVehicle.set(vehicleId, list);
  }
  const summaries: Summary[] = [];
  const allStops: Stop[] = [];
  const routeFiles: { key: string; data: FeatureCollection }[] = [];
  const inefficient: Record<string, unknown>[] = [];
  for (const [vehicleId, pings] of byVehicle) {
    pings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const vehicle = vehicles.get(vehicleId)!;
    const groups = new Map<string, Ping[]>();
    for (const ping of pings) {
      const group = groups.get(ping.timestamp.slice(0, 10)) ?? [];
      group.push(ping); groups.set(ping.timestamp.slice(0, 10), group);
    }
    for (const [date, day] of groups) {
      const stops = detectStops(day);
      for (const stop of stops) {
        const containing = zones.filter((zone) => pointInZone([stop.lon, stop.lat], zone));
        stop.zones = containing.map((zone) => zone.properties.name);
        const ownDepot = zones.find((zone) => zone.properties.type === "service" && zone.properties.zone_id === vehicle.depot);
        stop.in_own_depot_area = ownDepot ? pointInZone([stop.lon, stop.lat], ownDepot) : false;
        stop.restricted = containing.some((zone) => zone.properties.type === "restricted");
      }
      allStops.push(...stops);
      let distance = 0, movingMinutes = 0, stoppedMinutes = 0;
      const restrictedMinutes: Record<string, number> = Object.fromEntries(zones.filter((z) => z.properties.type === "restricted").map((z) => [z.properties.name, 0]));
      for (let i = 1; i < day.length; i++) {
        const previous = day[i - 1], current = day[i];
        const minutes = Math.max(0, (Date.parse(current.timestamp) - Date.parse(previous.timestamp)) / 60000);
        const segmentKm = haversineKm([previous.lon, previous.lat], [current.lon, current.lat]);
        if (minutes <= 30) {
          distance += segmentKm;
          if ((previous.speed_kmh ?? 0) >= 5 || (current.speed_kmh ?? 0) >= 5) movingMinutes += minutes;
          else stoppedMinutes += minutes;
          for (const zone of zones.filter((z) => z.properties.type === "restricted")) {
            if (pointInZone([previous.lon, previous.lat], zone) && pointInZone([current.lon, current.lat], zone)) restrictedMinutes[zone.properties.name] += minutes;
          }
        }
      }
      summaries.push({
        vehicle_id: vehicleId, date, distance_km: +distance.toFixed(3),
        moving_minutes: +movingMinutes.toFixed(1), stopped_minutes: +stoppedMinutes.toFixed(1),
        stop_count: stops.length,
        highest_believable_speed_kmh: day.reduce<number | null>((max, p) => p.speed_kmh !== null && (max === null || p.speed_kmh > max) ? p.speed_kmh : max, null),
        data_quality_issues: qualityCounts.get(vehicleId) ?? 0, restricted_minutes: restrictedMinutes
      });
      const routePoints = simplifyRoute(day.map((p) => [p.lon, p.lat]), 20);
      if (routePoints.length === 1) routePoints.push([...routePoints[0]]);
      const line: any = { type: "Feature", properties: { vehicle_id: vehicleId, date, kind: "route" }, geometry: { type: "LineString", coordinates: routePoints } };
      const stopFeatures = stops.map((stop) => ({ type: "Feature", properties: { ...stop, kind: "stop" }, geometry: { type: "Point", coordinates: [stop.lon, stop.lat] } }));
      const key = `${encodeURIComponent(vehicleId)}_${date}`;
      routeFiles.push({ key, data: { type: "FeatureCollection", features: [line, ...stopFeatures] } });

      let tripStart = 0, tripNumber = 0;
      for (const stop of stops) {
        const stopIndex = day.findIndex((p) => p.timestamp === stop.start_time);
        if (stopIndex > tripStart) {
          const trip = day.slice(tripStart, stopIndex + 1);
          const duration = (Date.parse(trip.at(-1)!.timestamp) - Date.parse(trip[0].timestamp)) / 60000;
          const tripDistance = trip.slice(1).reduce((sum, p, i) => sum + haversineKm([trip[i].lon, trip[i].lat], [p.lon, p.lat]), 0);
          if (duration > 60 && tripDistance < 5) inefficient.push({ vehicle_id: vehicleId, date, trip_number: ++tripNumber, start_time: trip[0].timestamp, end_time: trip.at(-1)!.timestamp, duration_minutes: +duration.toFixed(1), distance_km: +tripDistance.toFixed(3), stop_count: 1, reason: "Trip exceeded 60 minutes while covering under 5 km" });
        }
        tripStart = Math.max(tripStart, stopIndex);
      }
    }
  }
  const summaryKeys = new Set(summaries.map((summary) => `${summary.vehicle_id}/${summary.date}`));
  for (const vehicleId of vehicles.keys()) for (const date of processingDates) {
    const key = `${vehicleId}/${date}`;
    if (summaryKeys.has(key)) continue;
    const restrictedMinutes = Object.fromEntries(zones.filter((zone) => zone.properties.type === "restricted").map((zone) => [zone.properties.name, 0]));
    summaries.push({
      vehicle_id: vehicleId, date, distance_km: 0, moving_minutes: 0, stopped_minutes: 0,
      stop_count: 0, highest_believable_speed_kmh: null,
      data_quality_issues: qualityCounts.get(vehicleId) ?? 0, restricted_minutes: restrictedMinutes
    });
    routeFiles.push({ key: `${encodeURIComponent(vehicleId)}_${date}`, data: { type: "FeatureCollection", features: [] } });
  }
  summaries.sort((a, b) => a.date.localeCompare(b.date) || a.vehicle_id.localeCompare(b.vehicle_id));
  const writeJson = (name: string, value: unknown) => writeFile(join(outputDir, name), JSON.stringify(value, null, 2) + "\n");
  await mkdir(join(outputDir, "routes"), { recursive: true });
  await Promise.all([
    writeJson("summaries.json", summaries),
    writeJson("stops.json", allStops),
    writeJson("anomalies.json", anomalies),
    writeJson("inefficient_trips.json", inefficient),
    writeJson("zones.geojson", { type: "FeatureCollection", features: zones }),
    writeFile(join(outputDir, "rejects.csv"), stringifyCsv(anomalies, ["type", "vehicle_id", "timestamp", "reason", "action", "source_row"])),
    writeFile(join(outputDir, "data_quality_summary.csv"), stringifyCsv(
      Object.entries(anomalies.reduce<Record<string, number>>((counts, item) => { counts[item.type] = (counts[item.type] ?? 0) + 1; return counts; }, {}))
        .map(([type, affected_rows]) => ({ type, affected_rows })),
      ["type", "affected_rows"]
    )),
    writeFile(join(outputDir, "inefficient_trips.csv"), stringifyCsv(inefficient, ["vehicle_id", "date", "trip_number", "start_time", "end_time", "duration_minutes", "distance_km", "reason"])),
    writeFile(join(outputDir, "summaries.csv"), stringifyCsv(summaries, ["vehicle_id", "date", "distance_km", "moving_minutes", "stopped_minutes", "stop_count", "highest_believable_speed_kmh", "data_quality_issues", "restricted_minutes"])),
    ...routeFiles.map(({ key, data }) => writeJson(join("routes", `${key}.geojson`), data))
  ]);
  if (process.env.PROCESSED_BUCKET) {
    const client = new S3Client({});
    const upload = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await upload(path);
        else await client.send(new PutObjectCommand({
          Bucket: process.env.PROCESSED_BUCKET,
          Key: `processed/${relative(outputDir, path).split("\\").join("/")}`,
          Body: await readFile(path)
        }));
      }
    };
    await upload(outputDir);
  }
}
