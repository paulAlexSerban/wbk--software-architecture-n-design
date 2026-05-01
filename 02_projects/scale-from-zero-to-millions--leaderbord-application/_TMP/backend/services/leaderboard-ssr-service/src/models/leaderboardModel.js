const { getData } = require("./db");
const { instrumentModel } = require("../mvcObservability");

function getLeaderboard() {
  return instrumentModel("leaderboard", "getLeaderboard", () => {
    const { users } = getData();
    return users
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((user, index) => ({
        userId: user.id,
        score: user.score,
        rank: index + 1,
      }));
  });
}

module.exports = { getLeaderboard };
