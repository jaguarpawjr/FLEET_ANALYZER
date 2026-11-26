import { runPipeline } from "../src/analytics.js";

const input = process.argv[2];
const dataset = process.env.FLEET_DATASET ?? "assessment";
const output = process.argv[3] ?? (input || dataset === "demo" ? "data/processed" : "data/assessment-processed");
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
