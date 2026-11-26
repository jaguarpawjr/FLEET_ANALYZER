import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline } from "./analytics.js";

describe("cleaning and daily exports", () => {
  let temporaryDirectory = "";

  afterEach(async () => {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("traces rejected/changed rows, reports silent vehicles, and produces repeatable files", async () => {
    temporaryDirectory = await mkdtemp(join(process.cwd(), ".fleet-pipeline-test-"));
    const input = join(temporaryDirectory, "raw"), output = join(temporaryDirectory, "processed");
    await mkdir(input);
    await writeFile(join(input, "vehicles.csv"), "vehicle_id,plate,depot,depot_lat,depot_lon\nV1,AA1,D1,5.5,-0.2\nV2,AA2,D1,5.5,-0.2\n");
    await writeFile(join(input, "pings.csv"), [
      "vehicle_id,timestamp,lat,lon,speed_kmh,accuracy_m",
      "V1,2025-01-15T08:00:00Z,5.5,-0.2,0,5",
      "V1,2025-01-15T08:06:00Z,5.5,-0.2,0,5",
      "V1,2025-01-15T08:00:00Z,5.5,-0.2,0,5",
      "V1,2025-01-15T08:12:00Z,5.51,-0.19,200,5",
      "V1,2025-01-15T08:14:00Z,5.51,-0.19,20,150"
    ].join("\n"));
    await writeFile(join(input, "zones.geojson"), JSON.stringify({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { zone_id: "D1", name: "Depot", type: "service" }, geometry: { type: "Polygon", coordinates: [[[-0.21, 5.49], [-0.18, 5.49], [-0.18, 5.52], [-0.21, 5.52], [-0.21, 5.49]]] } }]
    }));

    await runPipeline(input, output);
    const firstSummaries = await readFile(join(output, "summaries.json"), "utf8");
    const rejects = await readFile(join(output, "rejects.csv"), "utf8");
    const summary = JSON.parse(firstSummaries);
    expect(summary).toHaveLength(2);
    expect(summary.find((item: any) => item.vehicle_id === "V1").stop_count).toBe(1);
    expect(summary.find((item: any) => item.vehicle_id === "V2").distance_km).toBe(0);
    expect(rejects).toContain("duplicate_ping");
    expect(rejects).toContain("implausible_speed");
    expect(rejects).toContain('""vehicle_id"":""V1""');
    await runPipeline(input, output);
    expect(await readFile(join(output, "summaries.json"), "utf8")).toBe(firstSummaries);
    expect(await readFile(join(output, "rejects.csv"), "utf8")).toBe(rejects);
  });

  it("keeps telemetry for a conflicted register ID without assigning either depot", async () => {
    temporaryDirectory = await mkdtemp(join(process.cwd(), ".fleet-conflict-test-"));
    const output = join(temporaryDirectory, "processed");
    await Promise.all([
      writeFile(join(temporaryDirectory, "pings_clean.csv"), [
        "_source_row,vehicle_id,timestamp,lat,lon,speed_kmh,accuracy_m,quality_issue_ids",
        "2,V1,2026-11-18T08:00:00Z,5.5,-0.2,0,5,",
        "3,V1,2026-11-18T08:06:00Z,5.5,-0.2,0,5,"
      ].join("\n")),
      writeFile(join(temporaryDirectory, "vehicles_clean.csv"), [
        "_source_row,vehicle_id,plate,depot,depot_lat,depot_lon,quality_issue_ids",
        "2,V1,AA-123,Depot A,5.5,-0.2,",
        "3,V1,BB-234,Depot B,5.6,-0.3,"
      ].join("\n")),
      writeFile(join(temporaryDirectory, "zones.geojson"), JSON.stringify({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { zone_id: "Depot A", name: "Depot A", type: "service" }, geometry: { type: "Polygon", coordinates: [[[-0.21, 5.49], [-0.18, 5.49], [-0.18, 5.52], [-0.21, 5.52], [-0.21, 5.49]]] } }]
      }))
    ]);

    await runPipeline(temporaryDirectory, output, {
      pings: "pings_clean.csv", vehicles: "vehicles_clean.csv", zones: "zones.geojson"
    });
    const summaries = JSON.parse(await readFile(join(output, "summaries.json"), "utf8"));
    const stops = JSON.parse(await readFile(join(output, "stops.json"), "utf8"));
    const anomalies = JSON.parse(await readFile(join(output, "anomalies.json"), "utf8"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ vehicle_id: "V1", data_quality_issues: 1, stop_count: 1 });
    expect(stops[0].in_own_depot_area).toBe(false);
    expect(anomalies).toContainEqual(expect.objectContaining({ type: "register_id_conflict", vehicle_id: "V1" }));
  });
});
