const { metrics, trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("leaderboard-ssr-service.mvc");
const meter = metrics.getMeter("leaderboard-ssr-service.mvc");

const controllerInvocations = meter.createCounter("mvc.controller.invocations", {
  description: "Number of controller actions executed.",
});
const viewRenderCount = meter.createCounter("mvc.view.render.count", {
  description: "Number of view renders executed.",
});
const modelOperationCount = meter.createCounter("mvc.model.operation.count", {
  description: "Number of model operations executed.",
});
const dbOperationCount = meter.createCounter("mvc.db.operation.count", {
  description: "Number of data-store operations executed.",
});

const viewRenderDuration = meter.createHistogram("mvc.view.render.duration", {
  description: "View render duration in milliseconds.",
  unit: "ms",
});
const modelOperationDuration = meter.createHistogram("mvc.model.operation.duration", {
  description: "Model operation duration in milliseconds.",
  unit: "ms",
});
const dbOperationDuration = meter.createHistogram("mvc.db.operation.duration", {
  description: "Data-store operation duration in milliseconds.",
  unit: "ms",
});

function durationMs(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function finishSpan(span, startNs, histogram, metricAttrs, error) {
  const elapsedMs = durationMs(startNs);
  histogram.record(elapsedMs, metricAttrs);
  span.setAttribute("duration.ms", elapsedMs);
  if (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

function withSyncSpan(spanName, spanAttrs, histogram, metricAttrs, fn) {
  return tracer.startActiveSpan(spanName, { attributes: spanAttrs }, (span) => {
    const startNs = process.hrtime.bigint();
    try {
      const result = fn(span);
      finishSpan(span, startNs, histogram, metricAttrs);
      return result;
    } catch (error) {
      finishSpan(span, startNs, histogram, metricAttrs, error);
      throw error;
    }
  });
}

function instrumentController(controller, action, transport, handler) {
  return function instrumentedController(req, res, next) {
    const attrs = { controller, action, transport };
    controllerInvocations.add(1, attrs);
    return tracer.startActiveSpan(
      `controller.${controller}.${action}`,
      {
        attributes: {
          "mvc.layer": "controller",
          "mvc.controller": controller,
          "mvc.action": action,
          "mvc.transport": transport,
        },
      },
      (span) => {
        try {
          const result = handler(req, res, next);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return result;
        } catch (error) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          span.end();
          throw error;
        }
      }
    );
  };
}

function instrumentModel(model, operation, fn) {
  const attrs = { model, operation };
  return withSyncSpan(
    `model.${model}.${operation}`,
    {
      "mvc.layer": "model",
      "mvc.model": model,
      "mvc.operation": operation,
    },
    modelOperationDuration,
    attrs,
    () => {
      modelOperationCount.add(1, attrs);
      return fn();
    }
  );
}

function instrumentDb(operation, fn) {
  const attrs = { operation };
  return withSyncSpan(
    `db.${operation}`,
    {
      "mvc.layer": "db",
      "db.operation": operation,
    },
    dbOperationDuration,
    attrs,
    () => {
      dbOperationCount.add(1, attrs);
      return fn();
    }
  );
}

function beginViewRender(view, extraAttrs = {}) {
  const attrs = { view, ...extraAttrs };
  viewRenderCount.add(1, attrs);
  const startNs = process.hrtime.bigint();
  const span = tracer.startSpan(`view.render.${view}`, {
    attributes: {
      "mvc.layer": "view",
      "mvc.view": view,
      ...Object.fromEntries(
        Object.entries(extraAttrs).map(([key, value]) => [`mvc.${key}`, value])
      ),
    },
  });

  return {
    done(error) {
      finishSpan(span, startNs, viewRenderDuration, attrs, error);
    },
  };
}

module.exports = {
  beginViewRender,
  instrumentController,
  instrumentDb,
  instrumentModel,
};
