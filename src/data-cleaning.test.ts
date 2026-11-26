import { describe, expect, it } from "vitest";
import { cleanDatasets } from "./data-cleaning/cleaner.js";
import { parseCsv, recordsFromCsv } from "./data-cleaning/csv.js";

describe("data-cleaning CSV and normalization", () => {
  it("parses quoted commas and escaped quotes", () => {
    expect(parseCsv('id,note\r\n1,"A, ""quoted"" value"\r\n')).toEqual([
      ["id", "note"],
      ["1", 'A, "quoted" value']
    ]);
  });

  it("rejects malformed source record widths with a clear location", () => {
    expect(() => recordsFromCsv("vehicle_id,timestamp\nGT-1001\n", ["vehicle_id", "timestamp"], "pings.csv"))
      .toThrow("pings.csv data record 1 has 1 fields; expected 2");
  });

  it("normalizes recoverable values, drops duplicate copies, and flags impossible jumps", () => {
    const epoch = String(Date.parse("2026-11-17T06:00:00.000Z") / 1000);
    const pings = [
      { vehicle_id: "GT1001", timestamp: epoch, lat: "-0,2", lon: "5,6", speed_kmh: "10", accuracy_m: "5" },
      { vehicle_id: "GT-1001", timestamp: "2026-11-17T06:00:00.000Z", lat: "5.6", lon: "-0.2", speed_kmh: "10", accuracy_m: "5" },
      { vehicle_id: "GT-1001", timestamp: "2026-11-17T06:00:30.000Z", lat: "5.9", lon: "-0.2", speed_kmh: "10", accuracy_m: "5" },
      { vehicle_id: "GT-1001", timestamp: "2026-11-17T06:01:00.000Z", lat: "5.9", lon: "-0.2", speed_kmh: "   ", accuracy_m: "   " }
    ];
    const pingColumns = ["vehicle_id", "timestamp", "lat", "lon", "speed_kmh", "accuracy_m"];
    const vehicleColumns = ["vehicle_id", "plate", "depot", "depot_lat", "depot_lon"];
    const result = cleanDatasets(
      pings,
      pingColumns,
      [{ vehicle_id: "GT-1001", plate: "GR 1001-26", depot: "Test", depot_lat: "5.6", depot_lon: "-0.2" }],
      vehicleColumns
    );

    expect(result.cleanedPings).toHaveLength(3);
    expect(result.cleanedPings[0].cleaned).toMatchObject({
      vehicle_id: "GT-1001",
      timestamp: "2026-11-17T06:00:00Z",
      lat: "5.6",
      lon: "-0.2"
    });
    expect(result.records.find((record) => record.sourceRow === 3)?.dropped).toBe(true);
    expect(result.cleanedPings[2].cleaned).toMatchObject({ speed_kmh: "", accuracy_m: "" });
    expect(result.issueSummaries.find((issue) => issue.issueId === "DQ-013")?.affectedRows).toBe(1);
    expect(result.issueSummaries.find((issue) => issue.issueId === "DQ-021")?.affectedRows).toBe(2);
    expect(result.issueSummaries.find((issue) => issue.issueId === "DQ-024")?.affectedRows).toBe(1);
    expect(result.telemetry.implausibleJumpSegments).toBe(1);
  });
});
