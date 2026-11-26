import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const send = (res: any, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(value));
};
export function createApiServer(outputDir = process.env.OUTPUT_DIR ?? "data/processed"): Server {
  const json = async (name: string) => JSON.parse(await readFile(join(outputDir, name), "utf8"));
  return createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type" });
    res.end(); return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method !== "GET") return send(res, 405, { error: { code: "method_not_allowed", message: "Only GET is supported" } });
    if (url.pathname === "/zones") return send(res, 200, await json("zones.geojson"));
    if (url.pathname === "/fleet") {
      const date = url.searchParams.get("date");
      if (!isValidDate(date)) return send(res, 400, { error: { code: "invalid_date", message: "date must be a real YYYY-MM-DD date" } });
      return send(res, 200, (await json("summaries.json")).filter((item: any) => item.date === date));
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

function isValidDate(date: string | null): date is string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 3000);
  createApiServer().listen(port, "0.0.0.0", () => console.log(`Fleet API listening on ${port}`));
}
