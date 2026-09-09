import express from "express";

/**
 * Middleware to reject array query parameters to prevent HTTP Parameter Pollution (HPP).
 * @param paramNames - List of query parameter keys to validate.
 */
export function rejectArrayParams(...paramNames: string[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (paramNames.some(p => Array.isArray(req.query[p]))) {
      res.status(400).json({ error: "Bad Request: array parameters not supported" });
      return;
    }
    next();
  };
}
