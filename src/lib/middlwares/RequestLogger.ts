import { NexxusHubApiRequest, NexxusHubApi } from '../Api.ts';

import { type NextFunction, type Response } from 'express';

export default (req: NexxusHubApiRequest, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;

    NexxusHubApi.logger.info(
      `${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`,
      { method: req.method, url: req.originalUrl, statusCode: res.statusCode, duration },
      NexxusHubApi.loggerLabel
    );
  });

  next();
};
