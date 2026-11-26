import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const send = (res: any, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(value));
};
export function createApiServer(
  outputDir = process.env.OUTPUT_DIR ?? "data/processed",
  paths: { assessmentDir?: string; inputDir?: string; registerFile?: string } = {}
): Server {
  const json = async (name: string) => JSON.parse(await readFile(join(outputDir, name), "utf8"));
  const assessmentFile = (name: string) => readFile(join(paths.assessmentDir ?? process.env.ASSESSMENT_DIR ?? process.cwd(), name), "utf8");
  const inputDir = paths.inputDir ?? process.env.INPUT_DIR ?? process.cwd();
  const registerFile = paths.registerFile ?? process.env.REGISTER_FILE ?? "vehicles_clean.csv";
  return createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type" });
    res.end(); return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method !== "GET") return send(res, 405, { error: { code: "method_not_allowed", message: "Only GET is supported" } });
    if (url.pathname === "/zones") return send(res, 200, await json("zones.geojson"));
    if (url.pathname === "/dates") {
      const summaries = await json("summaries.json");
      return send(res, 200, [...new Set(summaries.map((item: any) => item.date))].sort());
    }
    if (url.pathname === "/vehicles/register") {
      const rows = parseCsv(await readFile(join(inputDir, registerFile), "utf8"));
      const [headers, ...records] = rows;
      const registerRows = records.map((record) => Object.fromEntries(headers.map((header, i) => [header, record[i] ?? ""])));
      const byId = new Map<string, Record<string, string>[]>();
      for (const row of registerRows) {
        const id = row.vehicle_id?.trim();
        if (!id) continue;
        const matches = byId.get(id) ?? [];
        matches.push(row);
        byId.set(id, matches);
      }
      const vehicles = [...byId].map(([vehicle_id, sourceRows]) => {
        const ambiguous = sourceRows.length > 1;
        const distinct = (field: string) => [...new Set(sourceRows.map((row) => row[field] ?? ""))];
        const uniqueValue = (field: string) => {
          const values = distinct(field);
          return values.length === 1 ? values[0] : "";
        };
        return {
          vehicle_id,
          plate: ambiguous ? "" : uniqueValue("plate"),
          depot: ambiguous ? "" : uniqueValue("depot"),
          depot_lat: ambiguous ? "" : uniqueValue("depot_lat"),
          depot_lon: ambiguous ? "" : uniqueValue("depot_lon"),
          ambiguous,
          source_rows: sourceRows.map((row) => row._source_row ?? ""),
          register_rows: ambiguous ? sourceRows : []
        };
      });
      return send(res, 200, {
        registerRows: registerRows.length,
        uniqueVehicleIds: vehicles.length,
        conflicts: vehicles.filter((vehicle) => vehicle.ambiguous).length,
        vehicles
      });
    }
    if (url.pathname === "/fleet") {
      const date = url.searchParams.get("date");
      if (!isValidDate(date)) return send(res, 400, { error: { code: "invalid_date", message: "date must be a real YYYY-MM-DD date" } });
      return send(res, 200, (await json("summaries.json")).filter((item: any) => item.date === date));
    }
    if (url.pathname === "/data-quality/summary") {
      try {
        const summary = JSON.parse(await assessmentFile("data_quality_summary.json"));
        return send(res, 200, {
          period: "17–19 Nov 2026",
          source: "Part 1 assessment · data_quality_summary.json",
          sourcePings: summary.initial_row_counts?.pings ?? null,
          processed: summary.final_clean_row_counts?.pings_clean ?? null,
          uniquelyAffected: summary.row_treatment_totals?.unique_records_affected_by_any_issue ?? null,
          fixed: summary.row_treatment_totals?.rows_fixed ?? null,
          rejected: summary.row_treatment_totals?.rows_rejected ?? null,
          flagged: summary.row_treatment_totals?.rows_flagged ?? null,
          allChecksPassed: summary.all_quality_checks_passed === true,
          issueReferences: summary.issue_records ?? null,
          issues: (summary.issues ?? []).map(({ issueId, issueName, dataset, affectedRows, severity, decision, percentageAffected }: any) => ({
            issueId, issueName, dataset, affectedRows, severity, decision, percentageAffected
          }))
        });
      } catch {
        return send(res, 503, { error: { code: "quality_unavailable", message: "Assessment quality report files are unavailable" } });
      }
    }
    if (url.pathname === "/data-quality/issues") {
      try {
        const rows = parseCsv(await assessmentFile("data_quality_issues.csv"));
        const [headers, ...records] = rows;
        const allIssues = records.map((record) => Object.fromEntries(headers.map((header, i) => [header, record[i] ?? ""])));
        const filters = {
          severity: url.searchParams.get("severity") ?? "",
          action: url.searchParams.get("action") ?? "",
          dataset: url.searchParams.get("dataset") ?? "",
          issue_id: url.searchParams.get("issue_id") ?? "",
          vehicle_id: url.searchParams.get("vehicle_id")?.toLowerCase() ?? "",
          search: url.searchParams.get("search")?.toLowerCase() ?? ""
        };
        const filtered = allIssues.filter((issue: any) => {
          const record = parseJsonRecord(issue.original_record);
          return (!filters.severity || issue.severity === filters.severity) &&
            (!filters.action || issue.action === filters.action) &&
            (!filters.dataset || issue.dataset === filters.dataset) &&
            (!filters.issue_id || issue.issue_id === filters.issue_id) &&
            (!filters.vehicle_id || String(record.vehicle_id ?? "").toLowerCase().includes(filters.vehicle_id)) &&
            (!filters.search || `${issue.issue_name} ${issue.reason} ${issue.source_row} ${JSON.stringify(record)}`.toLowerCase().includes(filters.search));
        });
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size")) || 25));
        return send(res, 200, { page, pageSize, total: filtered.length, items: filtered.slice((page - 1) * pageSize, page * pageSize) });
      } catch {
        return send(res, 503, { error: { code: "quality_unavailable", message: "Assessment quality issue files are unavailable" } });
      }
    }
    if (url.pathname === "/inefficient-trips") return send(res, 200, await json("inefficient_trips.json"));
    if (url.pathname === "/anomalies") {
      const anomalies = await json("anomalies.json");
      const type = url.searchParams.get("type"), vehicleId = url.searchParams.get("vehicle_id");
      const filtered = anomalies.filter((item: any) => (!type || item.type === type) && (!vehicleId || item.vehicle_id === vehicleId));
      return send(res, 200, filtered);
    }
    const match = url.pathname.match(/^\/vehicles\/([A-Za-z0-9._-]+)\/days\/(\d{4}-\d{2}-\d{2})(?:\/(stops|route))?$/);
    if (!match) return send(res, 400, { error: { code: "invalid_request", message: "Invalid endpoint, vehicle ID, or date" } });
    const [, vehicleId, date, resource] = match;
    if (!isValidDate(date)) return send(res, 400, { error: { code: "invalid_date", message: "Date must be a real YYYY-MM-DD date" } });
    if (resource === "route") {
      try { return send(res, 200, await json(join("routes", `${encodeURIComponent(vehicleId)}_${date}.geojson`))); }
      catch { return send(res, 404, { error: { code: "not_found", message: "Route not found" } }); }
    }
    if (resource === "stops") {
      const summaries = await json("summaries.json");
      if (!summaries.some((item: any) => item.vehicle_id === vehicleId && item.date === date)) return send(res, 404, { error: { code: "not_found", message: "Vehicle-day summary not found" } });
      const stops = (await json("stops.json")).filter((stop: any) => stop.vehicle_id === vehicleId && stop.date === date);
      return send(res, 200, stops);
    }
    const summary = (await json("summaries.json")).find((item: any) => item.vehicle_id === vehicleId && item.date === date);
    return summary ? send(res, 200, summary) : send(res, 404, { error: { code: "not_found", message: "Vehicle-day summary not found" } });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: { code: "internal_error", message: "Analytics data is unavailable" } });
  }
  });
}

function parseCsv(input: string): string[][] {
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

function parseJsonRecord(value: string): Record<string, string> {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function isValidDate(date: string | null): date is string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 3000);
  createApiServer().listen(port, "0.0.0.0", () => console.log(`Fleet API listening on ${port}`));
}
