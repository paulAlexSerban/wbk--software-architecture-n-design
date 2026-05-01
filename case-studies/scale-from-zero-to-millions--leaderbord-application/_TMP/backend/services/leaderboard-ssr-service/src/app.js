const path = require("node:path");
const { randomUUID } = require("node:crypto");
const express = require("express");
const { trace, SpanStatusCode } = require("@opentelemetry/api");
const { engine } = require("express-handlebars");
const pinoHttp = require("pino-http");
const logger = require("./logger");
const { beginViewRender } = require("./mvcObservability");
const healthRoutes = require("./routes/health");
const leaderboardRoutes = require("./routes/leaderboard");
const usersRoutes = require("./routes/users");

const app = express();
const tracer = trace.getTracer("leaderboard-ssr-service.http");

function isNoisePath(url) {
	return (
		url === "/favicon.ico" ||
		url === "/.well-known/appspecific/com.chrome.devtools.json"
	);
}

app.engine("handlebars", engine({ defaultLayout: "main" }));
app.set("view engine", "handlebars");
app.set("views", path.join(__dirname, "views"));

// Health check before logger/tracer — no logging or tracing noise
app.use(healthRoutes);

app.use(
	pinoHttp({
		logger,
		genReqId(req, res) {
			const incomingId = req.headers["x-request-id"];
			const requestId =
				typeof incomingId === "string" && incomingId.trim()
					? incomingId
					: randomUUID();
			res.setHeader("x-request-id", requestId);
			return requestId;
		},
		customLogLevel(_req, res, err) {
			if (isNoisePath(_req.url)) return "silent";
			if (err || res.statusCode >= 500) return "error";
			if (res.statusCode >= 400) return "warn";
			return "info";
		},
	})
);

app.use((req, res, next) => {
	if (isNoisePath(req.url)) {
		return next();
	}

	tracer.startActiveSpan(`${req.method} ${req.path}`, (span) => {
		span.setAttribute("http.method", req.method);
		span.setAttribute("http.target", req.originalUrl || req.url);
		span.setAttribute("request.id", req.id);

		const originalRender = res.render.bind(res);
		res.render = (view, locals, callback) => {
			const renderSpan = beginViewRender(view, {
				controller: req.route?.path || req.path,
				transport: req.path.startsWith("/api/") ? "api" : "html",
			});

			const renderCallback = (error, html) => {
				renderSpan.done(error);
				if (typeof callback === "function") {
					return callback(error, html);
				}
				if (error) {
					return next(error);
				}
				return res.send(html);
			};

			return originalRender(view, locals, renderCallback);
		};

		res.on("finish", () => {
			const routePattern = req.route?.path;
			if (routePattern) {
				span.updateName(`${req.method} ${routePattern}`);
				span.setAttribute("http.route", routePattern);
			}
			span.setAttribute("http.status_code", res.statusCode);
			if (res.statusCode >= 500) {
				span.setStatus({ code: SpanStatusCode.ERROR });
			}
			span.end();
		});

		next();
	});
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(leaderboardRoutes);
app.use(usersRoutes);

// 404 — any unmatched route
app.use((req, res) => {
	res.status(404).render("not-found", {
		title: "Not Found",
		message: `Cannot ${req.method} ${req.path}`,
	});
});

// 500 — express error handler (4-arg signature required)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
	const span = trace.getActiveSpan();
	if (span) {
		span.recordException(err);
		span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
	}
	logger.error({ err }, "Unhandled route error");
	res.status(500).json({ error: "Internal Server Error" });
});

module.exports = app;
