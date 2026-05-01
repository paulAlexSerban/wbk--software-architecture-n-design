const express = require("express");
const usersController = require("../controllers/usersController");

const router = express.Router();

// HTML routes
router.get("/users", usersController.getUsers);
router.get("/users/:id", usersController.getUserById);

// API routes
router.get("/api/users", usersController.getUsersApi);

module.exports = router;
