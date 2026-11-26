export type Decision = "FIX" | "DROP" | "FLAG";
export type Dataset = "pings.csv" | "vehicles.csv";

export type IssueDefinition = {
  id: string;
  name: string;
  dataset: Dataset;
  columns: string[];
  discovery: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  decision: Decision;
  rule: string;
  justification: string;
  impact: string;
  verification: string;
};

export type IssueEvent = {
  issueId: string;
  dataset: Dataset;
  sourceRow: number;
  action: Decision;
  reason: string;
  details: string[];
  original: Record<string, string>;
  corrected: Record<string, string> | null;
};

export type CleanedRecord = {
  dataset: Dataset;
  sourceRow: number;
  original: Record<string, string>;
  cleaned: Record<string, string>;
  issueIds: Set<string>;
  dropped: boolean;
  fixed: boolean;
  flagged: boolean;
};

export type IssueSummary = {
  issueId: string;
  issueName: string;
  dataset: Dataset;
  columns: string[];
  affectedRows: number;
  percentageAffected: number;
  severity: IssueDefinition["severity"];
  decision: Decision;
  rule: string;
  justification: string;
  impact: string;
  verification: string;
  examples: Array<{
    sourceRow: number;
    original: Record<string, string>;
    corrected: Record<string, string> | null;
    reason: string;
    details: string[];
  }>;
};

export type CleanResult = {
  pingColumns: string[];
  vehicleColumns: string[];
  cleanedPings: CleanedRecord[];
  cleanedVehicles: CleanedRecord[];
  records: CleanedRecord[];
  events: IssueEvent[];
  issueSummaries: IssueSummary[];
  inputCounts: { pings: number; vehicles: number };
  telemetry: {
    stationaryPairsWithin5m: number;
    reportingIntervalsOver90Seconds: number;
    reportingIntervalSeconds: { median: number | null; p95: number | null; maximum: number | null };
    implausibleJumpSegments: number;
  };
};
