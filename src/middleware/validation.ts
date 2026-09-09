import express from "express";

/**
 * Middleware to reject array query parameters to prevent HTTP Parameter Pollution (HPP).
 * @param paramNames - List of query parameter keys to validate.
 */
export function rejectArrayParams(...paramNames: string[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (paramNames.some(p => typeof req.query[p] !== 'undefined' && typeof req.query[p] !== 'string')) {
      res.status(400).json({ error: "Bad Request: invalid parameter type, string expected" });
      return;
    }
    next();
  };
}
