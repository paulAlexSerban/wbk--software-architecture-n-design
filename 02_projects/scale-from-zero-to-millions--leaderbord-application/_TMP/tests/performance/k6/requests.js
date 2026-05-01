import http from "k6/http";
import { check } from "k6";

import { BASE_URL } from "./config.js";
import { parseJsonOrNull } from "./helpers.js";
import { businessFailures, markCoverage, recordLatency } from "./metrics.js";

function getJson(path, tags) {
  const response = http.get(`${BASE_URL}${path}`, { tags });
  const ok = check(response, {
    [`${tags.name} status`]: (r) => r.status === 200,
  });
  markCoverage(tags.name, ok);
  businessFailures.add(ok ? 0 : 1, { endpoint: path });
  recordLatency(path, response, "api");
  return response;
}

function getHtml(path, tags) {
  const response = http.get(`${BASE_URL}${path}`, { tags });
  const ok = check(response, {
    [`${tags.name} status`]: (r) => r.status === 200,
    [`${tags.name} contains html`]: (r) =>
      (r.headers["Content-Type"] || "").includes("text/html"),
  });
  markCoverage(tags.name, ok);
  businessFailures.add(ok ? 0 : 1, { endpoint: path });
  recordLatency(path, response, "html");
  return response;
}

function getCss(path, tags) {
  const response = http.get(`${BASE_URL}${path}`, { tags });
  const ok = check(response, {
    [`${tags.name} status`]: (r) => r.status === 200,
    [`${tags.name} contains css`]: (r) =>
      (r.headers["Content-Type"] || "").includes("text/css"),
  });
  markCoverage(tags.name, ok);
  businessFailures.add(ok ? 0 : 1, { endpoint: path });
  recordLatency(path, response, "css");
  return response;
}



function triggerLogLevelProbe(iterHint = null) {
  const endpoint = "GET /health/log-probe";
  const vu = typeof __VU === "number" ? __VU : "setup";
  const iter =
    iterHint !== null
      ? iterHint
      : typeof __ITER === "number"
        ? __ITER
        : "setup";
  const response = http.get(
    `${BASE_URL}/health/log-probe?source=k6&vu=${vu}&iter=${iter}`,
    {
      tags: { name: endpoint },
    }
  );

  check(response, {
    "GET /health/log-probe status": (r) => r.status === 200,
  });
}

function getUserApiById(id) {
  const endpoint = "GET /api/users/:id";
  const response = http.get(`${BASE_URL}/api/users/${id}`, {
    tags: { name: endpoint },
  });
  const ok = check(response, {
    "GET /api/users/:id status": (r) => r.status === 200,
    "GET /api/users/:id has id": (r) => {
      const userId = parseJsonOrNull(r, "id");
      return typeof userId === "number";
    },
  });
  markCoverage(endpoint, ok);
  businessFailures.add(ok ? 0 : 1, {
    endpoint: "/api/users/:id",
    method: "GET",
  });
  recordLatency("/api/users/:id", response, "api");
  return response;
}

function getUserHtmlById(id) {
  const endpoint = "GET /users/:id";
  const response = http.get(`${BASE_URL}/users/${id}`, {
    tags: { name: endpoint },
  });
  const ok = check(response, {
    "GET /users/:id status": (r) => r.status === 200,
    "GET /users/:id contains html": (r) =>
      (r.headers["Content-Type"] || "").includes("text/html"),
  });
  markCoverage(endpoint, ok);
  businessFailures.add(ok ? 0 : 1, { endpoint: "/users/:id", method: "GET" });
  recordLatency("/users/:id", response, "html");
  return response;
}

function getSeedUserId() {
  const response = getJson("/api/users", { name: "GET /api/users" });
  const users = parseJsonOrNull(response);
  if (!Array.isArray(users) || users.length === 0) {
    businessFailures.add(1, { endpoint: "/api/users", reason: "no_seed_user" });
    return null;
  }
  const firstId = users[0]?.id;
  return typeof firstId === "number" ? firstId : null;
}

export {
  getHtml,
  getCss,
  getJson,
  getSeedUserId,
  getUserApiById,
  getUserHtmlById,
  triggerLogLevelProbe,
};