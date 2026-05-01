// Use a factory mock so the same jest.fn() instances are shared between the
// test and the freshly-required db module after each jest.resetModules().
jest.mock("node:fs", () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

describe("db", () => {
  const FAKE_DATA = { users: [{ id: 1, name: "Alice", score: 100 }] };
  let fs;

  beforeEach(() => {
    // Reset module cache so db.js gets a fresh data=null state each test.
    jest.resetModules();
    // Re-require fs FIRST to seed the module registry with the mock instance.
    // db.js's require("node:fs") will then resolve to this same object.
    fs = require("node:fs");
    jest.clearAllMocks();
  });

  describe("getData()", () => {
    it("returns parsed JSON when the data file exists", () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(FAKE_DATA));

      const { getData } = require("../../models/db");
      expect(getData()).toEqual(FAKE_DATA);
    });

    it("returns empty users array when the data file does not exist", () => {
      fs.existsSync.mockReturnValue(false);

      const { getData } = require("../../models/db");
      expect(getData()).toEqual({ users: [] });
    });

    it("caches data across multiple calls", () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(FAKE_DATA));

      const { getData } = require("../../models/db");
      getData();
      getData();

      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("saveData()", () => {
    it("writes the current data object to disk as formatted JSON", () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(FAKE_DATA));

      const { getData, saveData } = require("../../models/db");
      getData();
      saveData();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify(FAKE_DATA, null, 2),
        "utf8"
      );
    });
  });
});
