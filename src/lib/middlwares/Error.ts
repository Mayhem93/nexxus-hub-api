import { NexxusHubApiException, ServerErrorException } from '../Exceptions.ts';
import { NexxusException, FatalErrorException } from '@mayhem93/nexxus-core-lib';

import { Request, Response, NextFunction } from 'express';
import { NexxusHubApi } from '../Api.ts';

export default async (err: Error | NexxusHubApiException, req: Request, res: Response, next: NextFunction) : Promise<void> => {
  if (!(err instanceof NexxusException)) {
    err = new ServerErrorException('An unexpected server error occurred.');
  }

  if (err instanceof FatalErrorException) {
    err = new ServerErrorException('A fatal server error occurred.');
  }

  const statusCode = (err as NexxusHubApiException).statusCode || 500;

  if (statusCode >= 500) {
    NexxusHubApi.logger.error(`${err.message}\n${err.stack}`, { name: err.name, stack: err.stack }, NexxusHubApi.loggerLabel);
  }

  const errorResponse = {
    error: err.name,
    message: err.message,
    ...(process.env.NODE_ENV === 'dev' && { stack: err.stack })
  };

  res.status(statusCode).json(errorResponse);
};
