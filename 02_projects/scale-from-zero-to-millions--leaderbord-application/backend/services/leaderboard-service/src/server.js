const path = require("node:path");
const express = require("express");
const { engine } = require("express-handlebars");
const { initializeDatabase } = require("./storage");
const leaderboardRoutes = require("./routes/leaderboard");
const usersRoutes = require("./routes/users");

const PORT = process.env.PORT || 3000;
const app = express();

initializeDatabase();

app.engine(
  "handlebars",
  engine({
    defaultLayout: "main",
  })
);
app.set("view engine", "handlebars");
app.set("views", path.join(__dirname, "views"));

app.use(express.static(path.join(__dirname, "public")));

// Routes
app.use(leaderboardRoutes);
app.use(usersRoutes);

app.listen(PORT, () => {
  console.log(`Leaderboard SSR service listening on port ${PORT}`);
});
