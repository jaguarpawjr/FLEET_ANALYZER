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
    await mkdir(join(directory, "input"));
    await Promise.all([
      writeFile(join(directory, "summaries.json"), JSON.stringify([{ vehicle_id: "V1", date: "2025-01-15", distance_km: 12 }])),
      writeFile(join(directory, "stops.json"), "[]"),
      writeFile(join(directory, "anomalies.json"), "[]"),
      writeFile(join(directory, "inefficient_trips.json"), "[]"),
      writeFile(join(directory, "zones.geojson"), '{"type":"FeatureCollection","features":[]}'),
      writeFile(join(directory, "routes", "V1_2025-01-15.geojson"), '{"type":"FeatureCollection","features":[]}'),
      writeFile(join(directory, "input", "vehicles.csv"), "vehicle_id,plate,depot,depot_lat,depot_lon\nV1,AA-123,Depot A,5.5,-0.2\n"),
      writeFile(join(directory, "data_quality_summary.json"), JSON.stringify({
        final_clean_row_counts: { pings_clean: 100 },
        row_treatment_totals: { unique_records_affected_by_any_issue: 12, rows_fixed: 8, rows_rejected: 2, rows_flagged: 3 },
        issue_records: 13,
        issues: [{ issueId: "DQ-001", issueName: "Bad coordinate", dataset: "pings.csv", affectedRows: 4, severity: "High", decision: "DROP", percentageAffected: 4 }]
      })),
      writeFile(join(directory, "data_quality_issues.csv"), [
        "dataset,source_row,issue_id,issue_name,affected_columns,severity,action,reason,details,original_record,corrected_record",
        'pings.csv,7,DQ-001,"Bad coordinate",lat,High,DROP,"Outside region",[],"{""vehicle_id"":""V1""}",',
        'pings.csv,8,DQ-001,"Bad coordinate",lat,High,DROP,"Outside region",[],"{""vehicle_id"":""V2""}",'
      ].join("\n"))
    ]);
    server = createApiServer(directory, { assessmentDir: directory, inputDir: join(directory, "input") });
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

  it("exposes available analytics dates and the aligned vehicle register", async () => {
    expect(await (await fetch(`${baseUrl}/dates`)).json()).toEqual(["2025-01-15"]);
    expect(await (await fetch(`${baseUrl}/vehicles/register`)).json()).toEqual([
      { vehicle_id: "V1", plate: "AA-123", depot: "Depot A", depot_lat: "5.5", depot_lon: "-0.2" }
    ]);
  });

  it("returns assessment totals separately from paginated filtered issue records", async () => {
    const summary = await (await fetch(`${baseUrl}/data-quality/summary`)).json();
    expect(summary).toMatchObject({ processed: 100, uniquelyAffected: 12, fixed: 8, rejected: 2, flagged: 3, issueReferences: 13 });
    expect(summary.issues).toHaveLength(1);
    const response = await fetch(`${baseUrl}/data-quality/issues?vehicle_id=V2&page=1&page_size=1`);
    expect(await response.json()).toMatchObject({ total: 1, items: [{ source_row: "8", action: "DROP" }] });
  });

  it("reports unavailable assessment files explicitly", async () => {
    const incompleteServer = createApiServer(directory, { assessmentDir: join(directory, "missing") });
    await new Promise<void>((resolve) => incompleteServer.listen(0, "127.0.0.1", resolve));
    const address = incompleteServer.address();
    if (!address || typeof address === "string") throw new Error("No API test port");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/data-quality/summary`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "quality_unavailable" } });
    } finally {
      await new Promise<void>((resolve, reject) => incompleteServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});
