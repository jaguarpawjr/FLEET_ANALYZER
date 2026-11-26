import React, { type ReactNode } from "react";

export function MetricCard({ label, value, detail, warning = false }: { label: string; value: ReactNode; detail: string; warning?: boolean }) {
  return <article aria-label={label}><span>{label}</span><strong className={warning ? "amber" : ""}>{value}</strong><small>{detail}</small></article>;
}
