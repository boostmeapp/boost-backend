import express from 'express';

/**
 * The app's JSON body parser, which also keeps the exact request bytes as
 * `req.rawBody` for the given path prefixes. Webhook signatures are computed
 * over those bytes; verifying against re-serialised JSON fails intermittently.
 * Scoped by path so no other request pays for the copy.
 */
export const jsonWithRawBody = (rawBodyPaths: string[], limit = '10mb') =>
  express.json({
    limit,
    verify: (req: any, _res, buf: Buffer) => {
      if (rawBodyPaths.some((p) => req.originalUrl?.startsWith(p))) {
        req.rawBody = buf;
      }
    },
  });
