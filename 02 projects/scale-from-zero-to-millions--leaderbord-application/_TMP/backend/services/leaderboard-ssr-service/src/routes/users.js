const express = require("express");
const usersController = require("../controllers/usersController");

const router = express.Router();

// HTML routes
router.get("/users", usersController.getUsers);
router.get("/users/:id", usersController.getUserById);

// API routes
router.get("/api/users", usersController.getUsersApi);
router.get("/api/users/:id", usersController.getUserByIdApi);
router.post("/api/user", usersController.createUser);
router.put("/api/user/:id", usersController.updateUser);
router.delete("/api/user/:id", usersController.deleteUser);

module.exports = router;
