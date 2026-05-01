import { check, group, sleep } from "k6";

import { BASELINE_LABEL, BASE_URL, options, PROFILE, RUN_TAG, STORAGE_LAYER } from "./config.js";
import { getJson, getSeedUserId, triggerLogLevelProbe } from "./requests.js";
import { runEndpointSweep, runReadHeavyMix } from "./workflows.js";

export { options };

export function setup() {
  const response = getJson("/health", { name: "GET /health" });
  check(response, {
    "health says ok": (r) => {
      try {
        return r.json("status") === "ok";
      } catch (_err) {
        return false;
      }
    },
  });

  const seedUserId = getSeedUserId();
  triggerLogLevelProbe("setup");

  return {
    seededAt: new Date().toISOString(),
    seedUserId,
  };
}

export default function (data) {
  const seedUserId =
    typeof data?.seedUserId === "number" ? data.seedUserId : 1;

  if (__ITER % 20 === 0) {
    triggerLogLevelProbe();
  }

  if (__ITER % 25 === 0) {
    group("full-endpoint-sweep", () => {
      runEndpointSweep(seedUserId);
    });
    sleep(Math.random() * 0.5 + 0.1);
    return;
  }

  const mix = Math.random();

  group("read-heavy-mix", () => {
    runReadHeavyMix(seedUserId, mix);
  });

  sleep(Math.random() * 0.8 + 0.2);
}

export function handleSummary(data) {
  return {
    stdout: `\nK6 profile: ${PROFILE}\nBase URL: ${BASE_URL}\n${JSON.stringify(
      {
        run_tag: RUN_TAG,
        storage_layer: STORAGE_LAYER,
        baseline_label: BASELINE_LABEL,
        http_req_failed: data.metrics.http_req_failed,
        http_req_duration: data.metrics.http_req_duration,
        checks: data.metrics.checks,
        business_failures: data.metrics.business_failures,
        iteration_duration: data.metrics.iteration_duration,
      },
      null,
      2
    )}`,
  };
}
