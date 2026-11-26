import { runPipeline } from "../src/analytics.js";

const input = process.argv[2];
const output = process.argv[3] ?? "data/processed";
const dataset = process.env.FLEET_DATASET ?? "assessment";
const pipeline = input
  ? runPipeline(input, output)
  : dataset === "demo"
    ? runPipeline("data/raw", output)
    : runPipeline(".", output, {
      pings: "pings_clean.csv",
      vehicles: "vehicles_clean.csv",
      zones: "zones.geojson"
    });

pipeline
  .then(() => console.log(`Fleet analytics outputs written to ${output} (${input || dataset} source)`))
  .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
