import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { isAppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` },
  });
};

/** Maps typed errors to HTTP. Anything unrecognised becomes an opaque 500. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    logger.warn({ err }, "request validation failed");
    res.status(422).json({
      error: {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        details: err.issues,
      },
    });
    return;
  }

  if (isAppError(err)) {
    const level = err.statusCode >= 500 ? "error" : "warn";
    logger[level]({ err, code: err.code }, err.message);
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
    });
    return;
  }

  logger.error({ err }, "unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
};
