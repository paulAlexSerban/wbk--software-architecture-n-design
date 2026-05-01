jest.mock("../../models/db");

const db = require("../../models/db");
const {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
} = require("../../models/userModel");

// Deliberately seeded in non-ascending id order so that mutations to the
// sort comparator (removed sort, wrong operator, stub function) all produce
// a wrong result that the "sorted by id" assertion will catch.
function makeUsers() {
  return [
    { id: 3, name: "Carol", score: 90, firstName: "Carol", lastName: "C" },
    { id: 1, name: "Alice", score: 80, firstName: "Alice", lastName: "A" },
    { id: 2, name: "Bob", score: 100, firstName: "Bob", lastName: "B" },
  ];
}

function seedDb(users) {
  const store = { users };
  db.getData.mockReturnValue(store);
  db.saveData.mockImplementation(() => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  seedDb(makeUsers());
});

describe("getUsers()", () => {
  it("returns all users sorted by id ascending", () => {
    const result = getUsers();
    expect(result.map((u) => u.id)).toEqual([1, 2, 3]);
  });

  it("does not mutate the stored array", () => {
    const before = db.getData().users.slice();
    getUsers();
    expect(db.getData().users).toEqual(before);
  });
});

describe("getUserById()", () => {
  it("returns the user with rank attached", () => {
    const user = getUserById(2);
    expect(user).toMatchObject({ id: 2, name: "Bob", rank: 1 });
  });

  it("returns null when the user does not exist", () => {
    expect(getUserById(99)).toBeNull();
  });

  it("attaches the correct rank based on score ordering", () => {
    // Bob=100 rank1, Carol=90 rank2, Alice=80 rank3
    expect(getUserById(1).rank).toBe(3);
    expect(getUserById(3).rank).toBe(2);
  });

  it("returns rank null when the user has no leaderboard entry", () => {
    // Simulate a user that exists in storage but is absent from the leaderboard
    // by having the two getData() calls return different data.
    const orphan = { id: 99, name: "Orphan", score: 0, firstName: "O", lastName: "R" };
    db.getData.mockReturnValueOnce({ users: [orphan] }); // getUserById lookup
    db.getData.mockReturnValueOnce({ users: [] });        // getLeaderboard lookup
    expect(getUserById(99).rank).toBeNull();
  });
});

describe("createUser()", () => {
  it("assigns the next sequential id", () => {
    const user = createUser({ name: "Dave", firstName: "Dave", lastName: "D", email: "d@d.com", score: 0 });
    expect(user.id).toBe(4);
  });

  it("defaults score to 0 when not provided", () => {
    const user = createUser({ name: "Dave", firstName: "Dave", lastName: "D", email: "d@d.com" });
    expect(user.score).toBe(0);
  });

  it("persists the new user to the store", () => {
    createUser({ name: "Dave", firstName: "Dave", lastName: "D", email: "d@d.com" });
    expect(db.getData().users).toHaveLength(4);
  });

  it("calls saveData after creating a user", () => {
    createUser({ name: "Dave", firstName: "Dave", lastName: "D", email: "d@d.com" });
    expect(db.saveData).toHaveBeenCalledTimes(1);
  });

  it("assigns id 1 when the users array is empty", () => {
    seedDb([]);
    const user = createUser({ name: "New", firstName: "New", lastName: "User", email: "new@u.com" });
    expect(user.id).toBe(1);
  });
});

describe("updateUser()", () => {
  it("updates and returns the modified user", () => {
    const updated = updateUser(1, { score: 999 });
    expect(updated).toMatchObject({ id: 1, score: 999 });
  });

  it("returns null when the user does not exist", () => {
    expect(updateUser(99, { score: 1 })).toBeNull();
  });

  it("does not allow overwriting the id field", () => {
    updateUser(1, { id: 99, score: 50 });
    expect(db.getData().users.find((u) => u.id === 1)).toBeDefined();
  });

  it("calls saveData after a successful update", () => {
    updateUser(1, { score: 999 });
    expect(db.saveData).toHaveBeenCalledTimes(1);
  });

  it("does not call saveData when user is not found", () => {
    updateUser(99, { score: 1 });
    expect(db.saveData).not.toHaveBeenCalled();
  });
});

describe("deleteUser()", () => {
  it("returns true and removes the user when found", () => {
    const result = deleteUser(1);
    expect(result).toBe(true);
    expect(db.getData().users.find((u) => u.id === 1)).toBeUndefined();
  });

  it("returns false when the user does not exist", () => {
    expect(deleteUser(99)).toBe(false);
  });

  it("calls saveData after a successful delete", () => {
    deleteUser(1);
    expect(db.saveData).toHaveBeenCalledTimes(1);
  });

  it("does not call saveData when user is not found", () => {
    deleteUser(99);
    expect(db.saveData).not.toHaveBeenCalled();
  });
});
