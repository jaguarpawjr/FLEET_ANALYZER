import type { FeatureCollection } from "geojson";

export type Vehicle = {
  vehicle_id: string;
  plate: string;
  depot: string;
  depot_lat: string;
  depot_lon: string;
  ambiguous: boolean;
  source_rows: string[];
  register_rows: Array<Record<string, string>>;
};

export type VehicleRegister = {
  registerRows: number;
  uniqueVehicleIds: number;
  conflicts: number;
  vehicles: Vehicle[];
};

export type QualityIssue = {
  dataset: string;
  source_row: string;
  issue_id: string;
  issue_name: string;
  affected_columns: string;
  severity: string;
  action: string;
  reason: string;
  details: string;
  original_record: string;
  corrected_record: string;
};

export type IssuePage = { page: number; pageSize: number; total: number; items: QualityIssue[] };

const API = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API}${path}`, { signal });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      message = (await response.json()).error?.message ?? message;
    } catch {
      // Keep the HTTP status when the server does not return JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const dashboardApi = {
  dates: (signal?: AbortSignal) => request<string[]>("/dates", signal),
  register: (signal?: AbortSignal) => request<VehicleRegister>("/vehicles/register", signal),
  zones: (signal?: AbortSignal) => request<FeatureCollection>("/zones", signal),
  trips: (signal?: AbortSignal) => request<Trip[]>("/inefficient-trips", signal),
  fleet: (date: string, signal?: AbortSignal) => request<Summary[]>(`/fleet?date=${encodeURIComponent(date)}`, signal),
  route: (vehicleId: string, date: string, signal?: AbortSignal) =>
    request<FeatureCollection>(`/vehicles/${encodeURIComponent(vehicleId)}/days/${date}/route`, signal),
  stops: (vehicleId: string, date: string, signal?: AbortSignal) =>
    request<Stop[]>(`/vehicles/${encodeURIComponent(vehicleId)}/days/${date}/stops`, signal),
  qualitySummary: (signal?: AbortSignal) => request<QualitySummary>("/data-quality/summary", signal),
  qualityIssues: (params: URLSearchParams, signal?: AbortSignal) =>
    request<IssuePage>(`/data-quality/issues?${params}`, signal)
};

export type Summary = {
  vehicle_id: string;
  date: string;
  distance_km: number;
  moving_minutes: number;
  stopped_minutes: number;
  stop_count: number;
  highest_believable_speed_kmh: number | null;
  data_quality_issues: number;
  restricted_minutes: Record<string, number>;
};

export type Stop = {
  start_time: string;
  end_time: string;
  duration_minutes: number;
  lat: number;
  lon: number;
  zones: string[];
  restricted: boolean;
  in_own_depot_area?: boolean;
};

export type Trip = {
  vehicle_id: string;
  date: string;
  trip_number: number;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  distance_km: number;
  stop_count: number;
  reason: string;
};

export type QualityCategory = {
  issueId: string;
  issueName: string;
  dataset: string;
  affectedRows: number;
  severity: string;
  decision: string;
  percentageAffected: number;
};

export type QualitySummary = {
  period: string;
  source: string;
  sourcePings: number | null;
  processed: number | null;
  uniquelyAffected: number | null;
  fixed: number | null;
  rejected: number | null;
  flagged: number | null;
  issueReferences: number | null;
  allChecksPassed: boolean;
  issues: QualityCategory[];
};
