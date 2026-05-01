const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const PROFILE = (__ENV.K6_PROFILE || "load").toLowerCase();
const RUN_TAG = __ENV.K6_RUN_TAG || "adhoc";
const STORAGE_LAYER = __ENV.K6_STORAGE_LAYER || "unknown";
const BASELINE_LABEL = __ENV.K6_BASELINE_LABEL || "adhoc";

function optionsForProfile(profile) {
    const defaults = {
        thresholds: {
            http_req_failed: ["rate<0.02"],
            http_req_duration: ["p(95)<500", "p(99)<1200"],
            business_failures: ["rate<0.01"],
            "http_req_duration{name:GET /health}": ["p(95)<200"],
            "http_req_duration{name:GET /}": ["p(95)<700"],
            "http_req_duration{name:GET /users}": ["p(95)<700"],
            "http_req_duration{name:GET /styles.css}": ["p(95)<300"],
            "http_req_duration{name:GET /users/:id}": ["p(95)<800"],
            "http_req_duration{name:GET /api/users/:id}": ["p(95)<500"],
            "http_req_duration{name:POST /api/user}": ["p(95)<500"],
            "http_req_duration{name:PUT /api/user/:id}": ["p(95)<550"],
            "http_req_duration{name:DELETE /api/user/:id}": ["p(95)<500"],
            "http_req_duration{name:GET /api/leaderboard}": ["p(95)<450"],
            "http_req_duration{name:GET /api/users}": ["p(95)<600"],
            api_latency_ms: ["p(95)<500"],
            html_latency_ms: ["p(95)<800"],
            "endpoint_coverage{endpoint:GET /}": ["rate>0.95"],
            "endpoint_coverage{endpoint:GET /users}": ["rate>0.95"],
            "endpoint_coverage{endpoint:GET /users/:id}": ["rate>0.9"],
            "endpoint_coverage{endpoint:GET /api/leaderboard}": ["rate>0.95"],
            "endpoint_coverage{endpoint:GET /api/users}": ["rate>0.95"],
            "endpoint_coverage{endpoint:GET /api/users/:id}": ["rate>0.9"],
            "endpoint_coverage{endpoint:POST /api/user}": ["rate>0.9"],
            "endpoint_coverage{endpoint:PUT /api/user/:id}": ["rate>0.9"],
            "endpoint_coverage{endpoint:DELETE /api/user/:id}": ["rate>0.9"],
            checks: ["rate>0.99"],
        },
        discardResponseBodies: false,
        noConnectionReuse: false,
        userAgent: "k6-leaderboard-performance-suite/1.0",
        tags: {
            service: "leaderboard-ssr-service",
            test_profile: profile,
            run_tag: RUN_TAG,
            storage_layer: STORAGE_LAYER,
            baseline_label: BASELINE_LABEL,
        },
    };

    if (profile === "smoke") {
        return {
            ...defaults,
            scenarios: {
                smoke: {
                    executor: "constant-vus",
                    vus: 2,
                    duration: "1m",
                    gracefulStop: "10s",
                },
            },
        };
    }

    if (profile === "stress") {
        return {
            ...defaults,
            thresholds: {
                ...defaults.thresholds,
                http_req_failed: ["rate<0.20"],
                http_req_duration: ["p(95)<2800", "p(99)<7000"],
                "http_req_duration{name:GET /}": ["p(95)<3000"],
                "http_req_duration{name:GET /users}": ["p(95)<3400"],
                "http_req_duration{name:GET /users/:id}": ["p(95)<3800"],
                "http_req_duration{name:GET /styles.css}": ["p(95)<1800"],
                "http_req_duration{name:POST /api/user}": ["p(95)<4200"],
                "http_req_duration{name:PUT /api/user/:id}": ["p(95)<4200"],
                "http_req_duration{name:DELETE /api/user/:id}": ["p(95)<4200"],
                html_latency_ms: ["p(95)<3200"],
                business_failures: ["rate<0.02"],
            },
            scenarios: {
                stress: {
                    executor: "ramping-arrival-rate",
                    startRate: 4,
                    timeUnit: "1s",
                    preAllocatedVUs: 60,
                    maxVUs: 180,
                    stages: [
                        { target: 8, duration: "60s" },
                        { target: 16, duration: "120s" },
                        { target: 24, duration: "90s" },
                        { target: 0, duration: "1m" },
                    ],
                    gracefulStop: "2m",
                },
            },
        };
    }

    if (profile === "spike") {
        return {
            ...defaults,
            scenarios: {
                spike: {
                    executor: "ramping-arrival-rate",
                    startRate: 15,
                    timeUnit: "1s",
                    preAllocatedVUs: 80,
                    maxVUs: 400,
                    stages: [
                        { target: 15, duration: "1m" },
                        { target: 250, duration: "30s" },
                        { target: 250, duration: "2m" },
                        { target: 20, duration: "2m" },
                        { target: 0, duration: "1m" },
                    ],
                    gracefulStop: "30s",
                },
            },
        };
    }

    if (profile === "soak") {
        return {
            ...defaults,
            thresholds: {
                ...defaults.thresholds,
                http_req_duration: ["p(95)<700", "p(99)<1500"],
            },
            scenarios: {
                soak: {
                    executor: "constant-arrival-rate",
                    rate: 20,
                    timeUnit: "1s",
                    duration: "30m",
                    preAllocatedVUs: 60,
                    maxVUs: 200,
                    gracefulStop: "1m",
                },
            },
        };
    }

    return {
        ...defaults,
        scenarios: {
            load: {
                executor: "ramping-arrival-rate",
                startRate: 10,
                timeUnit: "1s",
                preAllocatedVUs: 40,
                maxVUs: 80,
                stages: [
                    { target: 15, duration: "1m" },
                    { target: 30, duration: "1m" },
                    { target: 60, duration: "1m" },
                    { target: 0, duration: "1m" },
                ],
                gracefulStop: "30s",
            },
        },
    };
}

const options = optionsForProfile(PROFILE);

export {
    BASE_URL,
    PROFILE,
    RUN_TAG,
    STORAGE_LAYER,
    BASELINE_LABEL,
    options,
    optionsForProfile,
};