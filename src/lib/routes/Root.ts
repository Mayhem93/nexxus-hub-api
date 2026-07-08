import { Response, Router } from 'express';
import { NexxusHubApiBaseRoute } from '../BaseRoute.ts';
import { NexxusHubApiRequest } from '../Api.ts';

export default class RootRoute extends NexxusHubApiBaseRoute {
  constructor(appRouter: Router) {
    super('/', appRouter);
  }

  protected registerRoutes(): void {
    this.router.get('/', (req: NexxusHubApiRequest, res: Response) => {
      res.status(200).send({ message: 'Welcome to the Nexxus Hub Api' });
    });
  }
}
