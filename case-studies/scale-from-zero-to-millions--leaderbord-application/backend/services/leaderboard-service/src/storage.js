const fs = require("node:fs");
const path = require("node:path");

const dataPath =
  process.env.DB_PATH || path.join(__dirname, "..", "data", "leaderboard.json");

let data = null;

function loadData() {
  if (data) return data;

  fs.mkdirSync(path.dirname(dataPath), { recursive: true });

  if (fs.existsSync(dataPath)) {
    const raw = fs.readFileSync(dataPath, "utf8");
    data = JSON.parse(raw);
  }

  return data;
}

const queries = {
  getLeaderboard() {
    const users = loadData().users;
    return users
      .map((user, index) => ({
        userId: user.id,
        name: user.name,
        score: user.score,
        rank: index + 1,
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
  },

  getUsers() {
    return loadData().users.sort((a, b) => a.id - b.id);
  },

  getUserById(id) {
    const users = loadData().users;
    const user = users.find((u) => u.id === id);

    if (!user) return null;

    const leaderboard = queries.getLeaderboard();
    const rankEntry = leaderboard.find((entry) => entry.userId === id);

    return {
      ...user,
      rank: rankEntry?.rank || null,
    };
  },
};

module.exports = {
  initializeDatabase,
  queries,
};
