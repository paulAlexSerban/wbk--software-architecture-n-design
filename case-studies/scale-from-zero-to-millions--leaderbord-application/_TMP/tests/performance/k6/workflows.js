import http from "k6/http";
import { check } from "k6";

import { BASE_URL } from "./config.js";
import { parseJsonOrNull, randomInt } from "./helpers.js";
import { businessFailures, markCoverage, recordLatency, writeOpsTotal } from "./metrics.js";
import {
    getHtml,
    getCss,
    getJson,
    getUserApiById,
    getUserHtmlById,
} from "./requests.js";

function createUpdateDeleteUser() {
    const suffix = `${Date.now()}-${__VU}-${__ITER}-${randomInt(1000, 9999)}`;
    const payload = {
        name: `k6-user-${suffix}`,
        firstName: "k6",
        lastName: "runner",
        email: `k6-${suffix}@example.test`,
    };

    const createResponse = http.post(
        `${BASE_URL}/api/user`,
        JSON.stringify(payload),
        {
            tags: { name: "POST /api/user" },
            headers: { "Content-Type": "application/json" },
        }
    );

    const createOk = check(createResponse, {
        "POST /api/user status": (r) => r.status === 201,
        "POST /api/user has id": (r) => {
            try {
                return Boolean(r.json("id"));
            } catch (_err) {
                return false;
            }
        },
    });
    markCoverage("POST /api/user", createOk);
    businessFailures.add(createOk ? 0 : 1, { endpoint: "/api/user", method: "POST" });
    recordLatency("/api/user", createResponse, "api");
    writeOpsTotal.add(1, { operation: "create" });

    if (!createOk) {
        return;
    }

    let createdId;
    try {
        createdId = createResponse.json("id");
    } catch (_err) {
        businessFailures.add(1, {
            endpoint: "/api/user",
            method: "POST",
            reason: "json_parse",
        });
        return;
    }

    const updatePayload = {
        score: randomInt(1, 10000),
        company: { name: "k6-inc" },
    };
    const updateResponse = http.put(
        `${BASE_URL}/api/user/${createdId}`,
        JSON.stringify(updatePayload),
        {
            tags: { name: "PUT /api/user/:id" },
            headers: { "Content-Type": "application/json" },
        }
    );

    const updateOk = check(updateResponse, {
        "PUT /api/user/:id status": (r) => r.status === 200,
    });
    markCoverage("PUT /api/user/:id", updateOk);
    businessFailures.add(updateOk ? 0 : 1, {
        endpoint: "/api/user/:id",
        method: "PUT",
    });
    recordLatency("/api/user/:id", updateResponse, "api");
    writeOpsTotal.add(1, { operation: "update" });

    const deleteResponse = http.del(`${BASE_URL}/api/user/${createdId}`, null, {
        tags: { name: "DELETE /api/user/:id" },
    });
    const deleteOk = check(deleteResponse, {
        "DELETE /api/user/:id status": (r) => r.status === 200,
    });
    markCoverage("DELETE /api/user/:id", deleteOk);
    businessFailures.add(deleteOk ? 0 : 1, {
        endpoint: "/api/user/:id",
        method: "DELETE",
    });
    recordLatency("/api/user/:id", deleteResponse, "api");
    writeOpsTotal.add(1, { operation: "delete" });
}

function createUsersConcurrently(count) {
    const responses = http.batch(
        Array.from({ length: count }, () => {
            const suffix = `${Date.now()}-${randomInt(1000, 9999)}`;
            const payload = {
                name: `k6-user-${suffix}`,
                firstName: "k6",
                lastName: "runner",
                email: `k6-${suffix}@example.test`,
                "address": {
                    "street": "123 Main St",
                    "city": "Anytown",
                    "state": "CA",
                    "zipcode": `${randomInt(10000, 99999)}`,
                },
                phone: `555-${randomInt(100, 999)}-${randomInt(1000, 9999)}`,
                website: `https://k6-${suffix}.example.test`,
                company: {
                    name: `k6-inc-${suffix}`,
                    catchPhrase: "Load testing made easy",
                    bs: "performance testing solutions",
                },
            };

            return {
                method: "POST",
                url: `${BASE_URL}/api/user`,
                body: JSON.stringify(payload),
                params: {
                    headers: { "Content-Type": "application/json" },
                    tags: { name: "POST /api/user" },
                },
            };
        })
    );
}

function updatedCreatedUsersConcurrently() {
    const usersResponse = getJson("/api/users", { name: "GET /api/users" });
    const usersPayload = parseJsonOrNull(usersResponse);
    if (!Array.isArray(usersPayload)) {
        businessFailures.add(1, {
            endpoint: "/api/users",
            method: "GET",
            reason: "json_parse",
        });
        return;
    }
    const users = usersPayload.filter((u) => u.name.startsWith("k6-user-") && typeof u.id === "number");
    const userMap = new Map(users.map((u) => [u.id, u]));

    const responses = http.batch(
        users.map((user) => {
            const existingUser = userMap.get(user.id);
            if (!existingUser) {
                return {
                    method: "PUT",
                    url: `${BASE_URL}/api/user/${user.id}`,
                    body: JSON.stringify({ score: randomInt(1, 10000) }),
                    params: {
                        headers: { "Content-Type": "application/json" },
                        tags: { name: "PUT /api/user/:id" },
                    },
                };
            }

            const suffix = `${Date.now()}-${randomInt(1000, 9999)}`;
            const payload = {
                name: existingUser.name,
                firstName: existingUser.firstName,
                lastName: existingUser.lastName,
                email: existingUser.email,
                score: randomInt(1, 10000),
                address: existingUser.address || {
                    street: "123 Main St",
                    city: "Anytown",
                    state: "CA",
                    zipcode: `${randomInt(10000, 99999)}`,
                },
                phone: existingUser.phone || `555-${randomInt(100, 999)}-${randomInt(1000, 9999)}`,
                website: existingUser.website || `https://k6-${suffix}.example.test`,
                company: existingUser.company || {
                    name: `k6-inc-${suffix}`,
                    catchPhrase: "Load testing made easy",
                    bs: "performance testing solutions",
                },
            };

            return {
                method: "PUT",
                url: `${BASE_URL}/api/user/${user.id}`,
                body: JSON.stringify(payload),
                params: {
                    headers: { "Content-Type": "application/json" },
                    tags: { name: "PUT /api/user/:id" },
                },
            };
        })
    );
}

function deleteUsersConcurrently() {
    const usersResponse = getJson("/api/users", { name: "GET /api/users" });
    const usersPayload = parseJsonOrNull(usersResponse);
    if (!Array.isArray(usersPayload)) {
        businessFailures.add(1, {
            endpoint: "/api/users",
            method: "GET",
            reason: "json_parse",
        });
        return;
    }
    const users = usersPayload.filter((u) => u.name.startsWith("k6-user-") && typeof u.id === "number");
    const userMap = new Map(users.map((u) => [u.id, u]));
    const responses = http.batch(
        users.map((user) => ({
            method: "DELETE",
            url: `${BASE_URL}/api/user/${user.id}`,
            params: {
                tags: { name: "DELETE /api/user/:id" },
            },
        }))
    );
}

function runEndpointSweep(seedUserId) {
    getJson("/api/leaderboard", { name: "GET /api/leaderboard" });
    getJson("/api/users", { name: "GET /api/users" });
    createUpdateDeleteUser();
    getHtml("/", { name: "GET /" });
    getCss("/styles.css", { name: "GET /styles.css" });
    getHtml("/users", { name: "GET /users" });
    getCss("/styles.css", { name: "GET /styles.css" });
    if (typeof seedUserId === "number") {
        getUserApiById(seedUserId);
        getUserHtmlById(seedUserId);
    }
    createUpdateDeleteUser();
    createUsersConcurrently(10);
    updatedCreatedUsersConcurrently();
    deleteUsersConcurrently();
}

function runReadHeavyMix(seedUserId, mix) {
    getJson("/api/leaderboard", { name: "GET /api/leaderboard" });
    getJson("/api/users", { name: "GET /api/users" });
    getHtml("/", { name: "GET /" });
    getCss("/styles.css", { name: "GET /styles.css" });
    getHtml("/users", { name: "GET /users" });
    getCss("/styles.css", { name: "GET /styles.css" });
    if (mix < 0.35) {
        getJson("/api/leaderboard", { name: "GET /api/leaderboard" });
    } else if (mix < 0.6) {
        getJson("/api/users", { name: "GET /api/users" });
    } else if (mix < 0.72) {
        getUserApiById(seedUserId);
    } else if (mix < 0.84) {
        getHtml("/users", { name: "GET /users" });
        getCss("/styles.css", { name: "GET /styles.css" });
    } else if (mix < 0.94) {
        getHtml("/", { name: "GET /" });
        getCss("/styles.css", { name: "GET /styles.css" });
    } else if (mix < 0.975) {
        getUserHtmlById(seedUserId);
    } else {
        createUpdateDeleteUser();
    }
}

export { createUpdateDeleteUser, runEndpointSweep, runReadHeavyMix };