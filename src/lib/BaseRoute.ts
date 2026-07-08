import { Router } from 'express';

export abstract class NexxusHubApiBaseRoute {
  protected router: Router;
  protected basePath: string;

  constructor(basePath: string, parentRouter: Router) {
    this.basePath = basePath;
    this.router = Router();
    this.registerRoutes();
    this.mountOn(parentRouter);
  }

  public getRouter(): Router {
    return this.router;
  }

  protected abstract registerRoutes(): void;

  private mountOn(parentRouter: Router): void {
    parentRouter.use(this.basePath, this.router);
  }
}
