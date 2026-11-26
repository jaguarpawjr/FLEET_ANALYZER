import { describe, expect, it } from "vitest";
import { detectStops, haversineKm, pointInZone, type Ping, type Zone } from "./core.js";

describe("fleet geospatial analytics", () => {
  it("calculates geodesic distance in kilometres", () => {
    expect(haversineKm([0, 0], [1, 0])).toBeCloseTo(111.195, 2);
  });

  it("detects stops lasting at least five minutes", () => {
    const pings: Ping[] = [
      { vehicle_id: "V1", timestamp: "2025-01-01T10:00:00.000Z", lat: 5, lon: 0, speed_kmh: 0, accuracy_m: 5 },
      { vehicle_id: "V1", timestamp: "2025-01-01T10:06:00.000Z", lat: 5, lon: 0, speed_kmh: 0, accuracy_m: 5 }
    ];
    expect(detectStops(pings)).toHaveLength(1);
    expect(detectStops(pings)[0].duration_minutes).toBe(6);
  });

  it("includes points inside a GeoJSON polygon", () => {
    const zone: Zone = { type: "Feature", properties: { zone_id: "z", name: "Test", type: "service" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } };
    expect(pointInZone([0.5, 0.5], zone)).toBe(true);
    expect(pointInZone([2, 2], zone)).toBe(false);
  });
});
