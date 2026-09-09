import express from "express";

/**
 * Middleware to reject array query parameters to prevent HTTP Parameter Pollution (HPP).
 * @param paramNames - List of query parameter keys to validate.
 */
export function rejectArrayParams(...paramNames: string[]) {
  if (paramNames.length === 0) {
    throw new Error("[rejectArrayParams] Middleware must be initialized with at least one parameter name.");
  }

  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const offending = paramNames.filter(p => Array.isArray(req.query[p]));
    if (offending.length > 0) {
      res.status(400).json({ error: `Bad Request: array parameters not supported for [${offending.join(', ')}]` });
      return;
    }
    next();
  };
}
