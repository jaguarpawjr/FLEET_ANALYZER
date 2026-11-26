import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApiServer } from "./server.js";

describe("daily summary API", () => {
  let directory: string;
  let baseUrl: string;
  let server: Server;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "fleet-api-"));
    await mkdir(join(directory, "routes"));
    await Promise.all([
      writeFile(join(directory, "summaries.json"), JSON.stringify([{ vehicle_id: "V1", date: "2025-01-15", distance_km: 12 }])),
      writeFile(join(directory, "stops.json"), "[]"),
      writeFile(join(directory, "anomalies.json"), "[]"),
      writeFile(join(directory, "inefficient_trips.json"), "[]"),
      writeFile(join(directory, "zones.geojson"), '{"type":"FeatureCollection","features":[]}'),
      writeFile(join(directory, "routes", "V1_2025-01-15.geojson"), '{"type":"FeatureCollection","features":[]}')
    ]);
    server = createApiServer(directory);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No API test port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it("returns a vehicle-day summary and validates dates", async () => {
    const response = await fetch(`${baseUrl}/vehicles/V1/days/2025-01-15`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ vehicle_id: "V1", date: "2025-01-15", distance_km: 12 });
    const invalid = await fetch(`${baseUrl}/vehicles/V1/days/2025-02-31`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: "invalid_date", message: "Date must be a real YYYY-MM-DD date" } });
  });
});
