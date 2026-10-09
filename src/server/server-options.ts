import { RequestHandler } from "express";

/** The asterisk request target asks about the server, not a session or route. */
export const serverOptions: RequestHandler = (req, res, next) => {
  if (req.originalUrl !== "*") return next();
  if (req.method !== "OPTIONS") { res.status(400).json({ error: "invalid_request" }); return; }
  res.setHeader("Allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  res.status(204).end();
};
