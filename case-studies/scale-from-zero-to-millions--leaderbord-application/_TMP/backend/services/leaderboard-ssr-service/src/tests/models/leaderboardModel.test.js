jest.mock("../../models/db");

const db = require("../../models/db");
const { getLeaderboard } = require("../../models/leaderboardModel");

// Re-created in beforeEach so each test gets a fresh reference.
// A module-level const would be sorted in-place by the first test,
// making the immutability assertion trivially true for all later tests.
let USERS;

beforeEach(() => {
  USERS = [
    { id: 1, name: "Alice", score: 80 },
    { id: 2, name: "Bob", score: 100 },
    { id: 3, name: "Carol", score: 90 },
  ];
  db.getData.mockReturnValue({ users: USERS });
});

describe("getLeaderboard()", () => {
  it("returns entries sorted by score descending", () => {
    const result = getLeaderboard();
    const scores = result.map((e) => e.score);
    expect(scores).toEqual([100, 90, 80]);
  });

  it("assigns rank 1 to the highest scorer", () => {
    const result = getLeaderboard();
    expect(result[0]).toMatchObject({ userId: 2, score: 100, rank: 1 });
  });

  it("assigns sequential ranks to all entries", () => {
    const result = getLeaderboard();
    expect(result.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("returns entries with userId, score, and rank only", () => {
    const result = getLeaderboard();
    result.forEach((entry) => {
      expect(Object.keys(entry).sort()).toEqual(["rank", "score", "userId"]);
    });
  });

  it("does not mutate the original users array", () => {
    const before = [...USERS];
    getLeaderboard();
    expect(USERS).toEqual(before);
  });

  it("returns an empty array when there are no users", () => {
    db.getData.mockReturnValue({ users: [] });
    expect(getLeaderboard()).toEqual([]);
  });
});
