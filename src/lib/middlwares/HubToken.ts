import { NoAuthPresentException, UserAuthenticationFailedException } from '../Exceptions.ts';
import { NexxusHubApi } from '../Api.ts';

import { type NextFunction, type Request, type Response } from 'express';

/**
 * Header nodes must present on every node -> Hub request, carrying the shared
 * secret. Case-insensitive on the wire; Express normalizes header keys to
 * lower case, which is what we read below.
 */
export const HUB_TOKEN_HEADER = 'nxx-hub-token';

/**
 * Shared-secret auth for all node -> Hub traffic. Nodes send the secret in the
 * `Nxx-Hub-Token` header; it must match Hub's configured `app.token`.
 *
 * Missing header -> 401 (NoAuthPresent). Present but wrong -> 401 (auth
 * failed). Both throw so the standard ErrorMiddleware renders the response.
 */
export default (req: Request, res: Response, next: NextFunction): void => {
  const provided = req.headers[HUB_TOKEN_HEADER];

  if (typeof provided !== 'string' || provided.length === 0) {
    throw new NoAuthPresentException(`Missing ${HUB_TOKEN_HEADER} header`);
  }

  if (provided !== NexxusHubApi.hubToken) {
    throw new UserAuthenticationFailedException('Invalid hub token');
  }

  next();
};
