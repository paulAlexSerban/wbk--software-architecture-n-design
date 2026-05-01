const { trace } = require("@opentelemetry/api");
const { instrumentController } = require("../mvcObservability");
const leaderboardModel = require("../models/leaderboardModel");
const userModel = require("../models/userModel");

exports.getLeaderboard = instrumentController("leaderboard", "getLeaderboard", "html", (_req, res) => {
  const entries = leaderboardModel.getLeaderboard();
  const users = userModel.getUsers();
  const nameById = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const leaderboard = entries.map((e) => ({ ...e, name: nameById[e.userId] }));
  trace.getActiveSpan()?.setAttribute("leaderboard.entries.count", leaderboard.length);
  res.render("leaderboard", {
    title: "Leaderboard",
    leaderboard,
  });
});

exports.getLeaderboardApi = instrumentController("leaderboard", "getLeaderboardApi", "api", (_req, res) => {
  const leaderboard = leaderboardModel.getLeaderboard();
  trace.getActiveSpan()?.setAttribute("leaderboard.entries.count", leaderboard.length);
  res.json({
    entries: leaderboard,
    lastUpdated: new Date().toISOString(),
  });
});
