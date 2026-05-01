const { trace } = require("@opentelemetry/api");
const { instrumentController } = require("../mvcObservability");
const userModel = require("../models/userModel");

exports.getUsers = instrumentController("users", "getUsers", "html", (_req, res) => {
  const users = userModel.getUsers();
  trace.getActiveSpan()?.setAttribute("users.count", users.length);
  res.render("users", {
    title: "Users",
    users,
  });
});

exports.getUserById = instrumentController("users", "getUserById", "html", (req, res) => {
  const id = Number(req.params.id);
  const span = trace.getActiveSpan();
  span?.setAttribute("user.id", id);

  const user = userModel.getUserById(id);

  if (!user) {
    span?.setAttribute("user.found", false);
    res.status(404).render("not-found", {
      title: "User Not Found",
      message: `No user found with id ${req.params.id}`,
    });
    return;
  }

  span?.setAttribute("user.found", true);
  res.render("user-profile", {
    title: `${user.firstName} ${user.lastName}`,
    user,
  });
});

exports.getUsersApi = instrumentController("users", "getUsersApi", "api", (_req, res) => {
  const users = userModel.getUsers();
  trace.getActiveSpan()?.setAttribute("users.count", users.length);
  res.json(users);
});

exports.getUserByIdApi = instrumentController("users", "getUserByIdApi", "api", (req, res) => {
  const id = Number(req.params.id);
  const span = trace.getActiveSpan();
  span?.setAttribute("user.id", id);
  const user = userModel.getUserById(id);
  if (!user) {
    span?.setAttribute("user.found", false);
    return res
      .status(404)
      .json({ error: `No user found with id ${req.params.id}` });
  }
  span?.setAttribute("user.found", true);
  res.json(user);
});

exports.createUser = instrumentController("users", "createUser", "api", (req, res) => {
  const { name, firstName, lastName, email } = req.body ?? {};
  if (!name || !firstName || !lastName || !email) {
    return res.status(400).json({
      error: "name, firstName, lastName, and email are required",
    });
  }
  const user = userModel.createUser(req.body);
  const span = trace.getActiveSpan();
  span?.setAttribute("user.id", user.id);
  span?.addEvent("user.created", { "user.id": String(user.id) });
  res.status(201).json(user);
});

exports.updateUser = instrumentController("users", "updateUser", "api", (req, res) => {
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: "Request body must not be empty" });
  }
  const id = Number(req.params.id);
  const span = trace.getActiveSpan();
  span?.setAttribute("user.id", id);
  const user = userModel.updateUser(id, req.body);
  if (!user) {
    span?.setAttribute("user.found", false);
    return res
      .status(404)
      .json({ error: `No user found with id ${req.params.id}` });
  }
  span?.setAttribute("user.found", true);
  span?.addEvent("user.updated", { "user.id": String(id) });
  res.json(user);
});

exports.deleteUser = instrumentController("users", "deleteUser", "api", (req, res) => {
  const id = Number(req.params.id);
  const span = trace.getActiveSpan();
  span?.setAttribute("user.id", id);
  const deleted = userModel.deleteUser(id);
  if (!deleted) {
    span?.setAttribute("user.found", false);
    return res
      .status(404)
      .json({ error: `No user found with id ${req.params.id}` });
  }
  span?.setAttribute("user.found", true);
  span?.addEvent("user.deleted", { "user.id": String(id) });
  res.json({ message: `User ${req.params.id} deleted successfully` });
});
