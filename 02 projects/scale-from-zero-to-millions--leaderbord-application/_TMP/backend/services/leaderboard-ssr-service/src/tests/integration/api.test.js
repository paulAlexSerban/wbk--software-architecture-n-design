// db.js is mocked so no file system is ever touched. The full pipeline
// route → controller → model is exercised against a controlled in-memory store.
jest.mock("../../models/db");

const request = require("supertest");
const db = require("../../models/db");
const app = require("../../app");

const SEED = [
  {
    id: 1,
    name: "Alice",
    firstName: "Alice",
    lastName: "A",
    score: 100,
    email: "alice@example.com",
    phone: "555-0001",
    website: "alice.com",
    address: { street: "1 Main St", suite: "Apt 1", city: "Springfield", zipcode: "12345" },
    company: { name: "Acme", catchPhrase: "Quality products", bs: "synergize" },
  },
  {
    id: 2,
    name: "Bob",
    firstName: "Bob",
    lastName: "B",
    score: 80,
    email: "bob@example.com",
    phone: "555-0002",
    website: "bob.com",
    address: { street: "2 Oak Ave", suite: "Suite 2", city: "Shelbyville", zipcode: "67890" },
    company: { name: "Globex", catchPhrase: "Excellence in everything", bs: "leverage" },
  },
];

let store;

beforeEach(() => {
  store = { users: SEED.map((u) => ({ ...u })) };
  db.getData.mockReturnValue(store);
  db.saveData.mockImplementation(() => {});
});

describe("Request correlation IDs", () => {
  it("returns an x-request-id header when none is provided", async () => {
    const res = await request(app).get("/api/users");
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("preserves caller-provided x-request-id", async () => {
    const requestId = "req-integration-test-123";
    const res = await request(app)
      .get("/api/users")
      .set("x-request-id", requestId);
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe(requestId);
  });
});

// ── SSR routes ────────────────────────────────────────────────────────────────

describe("SSR routes", () => {
  it("GET / returns 200 HTML", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  it("GET /users returns 200 HTML", async () => {
    const res = await request(app).get("/users");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  it("GET /users/:id returns 200 HTML for an existing user", async () => {
    const res = await request(app).get("/users/1");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  it("GET /users/:id returns 404 for a non-existent user", async () => {
    const res = await request(app).get("/users/99");
    expect(res.status).toBe(404);
  });
});

// ── GET /api/leaderboard ──────────────────────────────────────────────────────

describe("GET /api/leaderboard", () => {
  it("returns 200 with ranked entries and lastUpdated", async () => {
    const res = await request(app).get("/api/leaderboard");
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([
      { userId: 1, score: 100, rank: 1 },
      { userId: 2, score: 80, rank: 2 },
    ]);
    expect(res.body).toHaveProperty("lastUpdated");
  });
});

// ── GET /api/users ────────────────────────────────────────────────────────────

describe("GET /api/users", () => {
  it("returns 200 with all users sorted by id", async () => {
    const res = await request(app).get("/api/users");
    expect(res.status).toBe(200);
    expect(res.body.map((u) => u.id)).toEqual([1, 2]);
  });
});

// ── GET /api/users/:id ────────────────────────────────────────────────────────

describe("GET /api/users/:id", () => {
  it("returns 200 with the user and their rank", async () => {
    const res = await request(app).get("/api/users/1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1, name: "Alice", rank: 1 });
  });

  it("returns 404 with an error message for a non-existent user", async () => {
    const res = await request(app).get("/api/users/99");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ── POST /api/user ────────────────────────────────────────────────────────────

describe("POST /api/user", () => {
  const VALID_BODY = {
    name: "Carol",
    firstName: "Carol",
    lastName: "C",
    email: "carol@example.com",
  };

  it("returns 201 with the created user", async () => {
    const res = await request(app).post("/api/user").send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 3, ...VALID_BODY, score: 0 });
  });

  it("returns 400 when a required field is missing", async () => {
    const res = await request(app).post("/api/user").send({ name: "Carol" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when body is empty", async () => {
    const res = await request(app).post("/api/user").send({});
    expect(res.status).toBe(400);
  });
});

// ── PUT /api/user/:id ─────────────────────────────────────────────────────────

describe("PUT /api/user/:id", () => {
  it("returns 200 with the updated user", async () => {
    const res = await request(app).put("/api/user/1").send({ score: 999 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1, score: 999 });
  });

  it("returns 400 when body is empty", async () => {
    const res = await request(app).put("/api/user/1").send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for a non-existent user", async () => {
    const res = await request(app).put("/api/user/99").send({ score: 1 });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/user/:id ──────────────────────────────────────────────────────

describe("DELETE /api/user/:id", () => {
  it("returns 200 with a confirmation message", async () => {
    const res = await request(app).delete("/api/user/1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("message");
  });

  it("returns 404 for a non-existent user", async () => {
    const res = await request(app).delete("/api/user/99");
    expect(res.status).toBe(404);
  });
});
