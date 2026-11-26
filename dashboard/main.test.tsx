// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricCard } from "./MetricCard.js";

vi.mock("react-leaflet", () => ({
  CircleMarker: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  GeoJSON: () => null,
  MapContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Polyline: () => null,
  Popup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TileLayer: () => null,
  useMap: () => ({ fitBounds: vi.fn(), setView: vi.fn() })
}));

import { OperationsDashboard } from "./main.js";

const vehicles = [
  { vehicle_id: "V1", plate: "AA-123", depot: "Depot A", depot_lat: "5.5", depot_lon: "-0.2", ambiguous: false, source_rows: ["2"], register_rows: [] },
  { vehicle_id: "V2", plate: "BB-234", depot: "Depot B", depot_lat: "5.6", depot_lon: "-0.3", ambiguous: false, source_rows: ["3"], register_rows: [] }
];
const fleet = [
  { vehicle_id: "V1", date: "2026-11-17", distance_km: 20, moving_minutes: 60, stopped_minutes: 30, stop_count: 2, highest_believable_speed_kmh: 55, data_quality_issues: 2, restricted_minutes: {} },
  { vehicle_id: "V2", date: "2026-11-17", distance_km: 100, moving_minutes: 90, stopped_minutes: 20, stop_count: 1, highest_believable_speed_kmh: 70, data_quality_issues: 0, restricted_minutes: {} }
];
const trip = {
  vehicle_id: "V1", date: "2026-11-17", trip_number: 1, start_time: "2026-11-17T08:00:00Z",
  end_time: "2026-11-17T09:10:00Z", duration_minutes: 70, distance_km: 2, stop_count: 1,
  reason: "Trip exceeded 60 minutes while covering under 5 km"
};
const quality = {
  period: "17–19 Nov 2026", source: "Part 1", sourcePings: 32001, processed: 31076,
  uniquelyAffected: 7541, fixed: 6365, rejected: 925, flagged: 470, issueReferences: 7850,
  allChecksPassed: true, issues: []
};

function installApi() {
  const dataFor = (url: URL) => {
    switch (url.pathname) {
      case "/dates": return ["2026-11-17", "2026-11-18", "2026-11-19"];
      case "/vehicles/register": return { registerRows: 2, uniqueVehicleIds: 2, conflicts: 0, vehicles };
      case "/zones": return { type: "FeatureCollection", features: [] };
      case "/inefficient-trips": return [trip];
      case "/fleet": return fleet;
      case "/data-quality/summary": return quality;
      case "/data-quality/issues": return { page: 1, pageSize: 20, total: 0, items: [] };
      default:
        if (url.pathname.endsWith("/route")) return { type: "FeatureCollection", features: [] };
        if (url.pathname.endsWith("/stops")) return [];
        throw new Error(`Unexpected API request: ${url.pathname}`);
    }
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    status: 200,
    json: async () => dataFor(new URL(String(input)))
  })));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("fleet dashboard", () => {
  it("shows a metric card", () => {
    render(<MetricCard label="VEHICLES REPORTING" value={25} detail="in the selected day" />);
    expect(screen.getByRole("article", { name: "VEHICLES REPORTING" })).toBeTruthy();
    expect(screen.getByText("25")).toBeTruthy();
  });

  it("filters and sorts the fleet, then navigates into a returned trip", async () => {
    installApi();
    render(<OperationsDashboard />);
    await screen.findByRole("heading", { name: "Fleet overview" });

    const tableRows = () => [...document.querySelectorAll(".fleet-table tbody tr")];
    await waitFor(() => expect(tableRows()[0]?.textContent).toContain("V2"));
    fireEvent.change(screen.getByRole("textbox", { name: "Search vehicles" }), { target: { value: "V1" } });
    expect(tableRows()).toHaveLength(1);
    expect(tableRows()[0].textContent).toContain("V1");

    fireEvent.change(screen.getByRole("textbox", { name: "Search vehicles" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "DISTANCE" }));
    expect(tableRows()[0].textContent).toContain("V1");

    fireEvent.click(screen.getByRole("button", { name: /Inefficient trips/ }));
    await screen.findByRole("heading", { name: "Inefficient trips" });
    expect(screen.getByText(trip.reason)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open V1 analytics for 2026-11-17" }));
    await screen.findByRole("heading", { name: "V1" });
    expect(screen.getByRole("button", { name: "Fit route" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Service zones" })).toBeTruthy();
    expect(await screen.findByText("No route geometry for this vehicle-day")).toBeTruthy();
  });

  it("renders Part 1 action totals from the API without substituting values", async () => {
    installApi();
    render(<OperationsDashboard />);
    await screen.findByRole("heading", { name: "Fleet overview" });
    const primaryNav = screen.getByRole("navigation", { name: "Primary navigation" });
    fireEvent.click(within(primaryNav).getByRole("button", { name: "Data quality" }));

    const fixed = await screen.findByRole("article", { name: "FIXED" });
    const rejected = screen.getByRole("article", { name: "REJECTED" });
    const flagged = screen.getByRole("article", { name: "FLAGGED" });
    expect(within(fixed).getByText("6,365")).toBeTruthy();
    expect(within(rejected).getByText("925")).toBeTruthy();
    expect(within(flagged).getByText("470")).toBeTruthy();
    expect(screen.getByText("7,541")).toBeTruthy();
  });
});
