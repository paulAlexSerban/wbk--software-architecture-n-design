const { queries } = require("../storage");

exports.getLeaderboard = (_req, res) => {
  const leaderboard = queries.getLeaderboard();
  res.render("leaderboard", {
    title: "Leaderboard",
    leaderboard,
  });
};

exports.getLeaderboardApi = (_req, res) => {
  const leaderboard = queries.getLeaderboard();
  res.json({
    entries: leaderboard,
    lastUpdated: new Date().toISOString(),
  });
};
