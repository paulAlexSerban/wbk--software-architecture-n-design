const { queries } = require("../storage");

exports.getUsers = (_req, res) => {
  const users = queries.getUsers();
  res.render("users", {
    title: "Users",
    users,
  });
};

exports.getUserById = (req, res) => {
  const user = queries.getUserById(Number(req.params.id));

  if (!user) {
    res.status(404).render("not-found", {
      title: "User Not Found",
      message: `No user found with id ${req.params.id}`,
    });
    return;
  }

  res.render("user-profile", {
    title: `${user.firstName} ${user.lastName}`,
    user,
  });
};

exports.getUsersApi = (_req, res) => {
  const users = queries.getUsers();
  res.json(users);
};
