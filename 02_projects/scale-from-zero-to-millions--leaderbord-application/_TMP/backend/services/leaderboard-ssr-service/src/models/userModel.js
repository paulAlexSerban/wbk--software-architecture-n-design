const { getData, saveData } = require("./db");
const { getLeaderboard } = require("./leaderboardModel");
const { instrumentModel } = require("../mvcObservability");

function getUsers() {
  return instrumentModel("user", "getUsers", () => {
    const { users } = getData();
    return users.slice().sort((a, b) => a.id - b.id);
  });
}

function getUserById(id) {
  return instrumentModel("user", "getUserById", () => {
    const { users } = getData();
    const user = users.find((u) => u.id === id);

    if (!user) return null;

    const leaderboard = getLeaderboard();
    const rankEntry = leaderboard.find((entry) => entry.userId === id);

    return {
      ...user,
      rank: rankEntry?.rank ?? null,
    };
  });
}

function createUser(attrs) {
  return instrumentModel("user", "createUser", () => {
    const db = getData();
    const id =
      db.users.length > 0 ? Math.max(...db.users.map((u) => u.id)) + 1 : 1;
    const user = { id, score: 0, ...attrs };
    db.users.push(user);
    saveData();
    return user;
  });
}

function updateUser(id, attrs) {
  return instrumentModel("user", "updateUser", () => {
    const { users } = getData();
    const index = users.findIndex((u) => u.id === id);
    if (index === -1) return null;
    const { id: _id, ...safeAttrs } = attrs;
    users[index] = { ...users[index], ...safeAttrs };
    saveData();
    return users[index];
  });
}

function deleteUser(id) {
  return instrumentModel("user", "deleteUser", () => {
    const db = getData();
    const index = db.users.findIndex((u) => u.id === id);
    if (index === -1) return false;
    db.users.splice(index, 1);
    saveData();
    return true;
  });
}

module.exports = { getUsers, getUserById, createUser, updateUser, deleteUser };
