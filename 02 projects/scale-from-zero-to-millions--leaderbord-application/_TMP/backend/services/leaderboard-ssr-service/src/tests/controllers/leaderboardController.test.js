// Integration tests cover HTTP behaviour for all leaderboard routes.
// This file tests only the internal join logic that is not observable via the API.
jest.mock("../../models/leaderboardModel");
jest.mock("../../models/userModel");

const leaderboardModel = require("../../models/leaderboardModel");
const userModel = require("../../models/userModel");
const leaderboardController = require("../../controllers/leaderboardController");

function makeRes() {
  const res = {};
  res.render = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  leaderboardModel.getLeaderboard.mockReturnValue([
    { userId: 1, score: 100, rank: 1 },
    { userId: 2, score: 80, rank: 2 },
  ]);
  userModel.getUsers.mockReturnValue([
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ]);
});

describe("getLeaderboard() — SSR", () => {
  // The API model omits name; the controller joins it from the users list for the view.
  it("augments each leaderboard entry with the matching user name", () => {
    const res = makeRes();
    leaderboardController.getLeaderboard({}, res);
    const { leaderboard } = res.render.mock.calls[0][1];
    expect(leaderboard[0]).toMatchObject({ userId: 1, name: "Alice", rank: 1 });
    expect(leaderboard[1]).toMatchObject({ userId: 2, name: "Bob", rank: 2 });
  });
});
