const fs = require("node:fs");
const path = require("node:path");
const { instrumentDb } = require("../mvcObservability");

const dataPath =
  process.env.DB_PATH ||
  path.join(__dirname, "..", "..", "data", "leaderboard.json");

let data = null;

function getData() {
  return instrumentDb("getData", () => {
    if (data) return data;

    if (fs.existsSync(dataPath)) {
      const raw = fs.readFileSync(dataPath, "utf8");
      data = JSON.parse(raw);
    } else {
      data = { users: [] };
    }

    return data;
  });
}

function saveData() {
  return instrumentDb("saveData", () => {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf8");
  });
}

module.exports = { getData, saveData };
