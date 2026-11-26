// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricCard } from "./MetricCard.js";

describe("fleet dashboard component", () => {
  it("shows fleet count in the vehicle overview", () => {
    render(<MetricCard label="VEHICLES REPORTING" value={25} detail="in the selected day" />);
    expect(screen.getByRole("article", { name: "VEHICLES REPORTING" })).toBeTruthy();
    expect(screen.getByText("25")).toBeTruthy();
  });
});
