const express = require("express");
const leaderboardController = require("../controllers/leaderboardController");

const router = express.Router();

// HTML routes
router.get("/", leaderboardController.getLeaderboard);

// API routes
router.get("/api/leaderboard", leaderboardController.getLeaderboardApi);

module.exports = router;
