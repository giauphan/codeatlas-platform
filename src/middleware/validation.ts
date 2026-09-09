import express from "express";
import { logger } from "../utils/logger.js";

/**
 * Middleware to reject array query parameters to prevent HTTP Parameter Pollution (HPP).
 * @param paramNames - List of query parameter keys to validate.
 */
export function rejectArrayParams(...paramNames: string[]) {
  if (paramNames.length === 0) {
    logger.warn("[rejectArrayParams] Middleware created with empty paramNames array.");
  }

  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (paramNames.length === 0) return next();

    const offending = paramNames.filter(p => typeof req.query[p] !== 'undefined' && typeof req.query[p] !== 'string');
    if (offending.length > 0) {
      res.status(400).json({ error: `Bad Request: invalid parameter type for [${offending.join(', ')}], string expected` });
      return;
    }
    next();
  };
}
