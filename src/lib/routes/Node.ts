import { Response, Router } from 'express';
import { NexxusHubApiBaseRoute } from '../BaseRoute.ts';
import { NexxusHubApi, NexxusHubApiRequest } from '../Api.ts';
import { InvalidParametersException } from '../Exceptions.ts';
import { HubTokenMiddleware } from '../middlwares/index.ts';

interface RegisterNodeRequest extends NexxusHubApiRequest {
  body: {
    id: string;
    role: string;
    privateIpAddress: string;
    managementPort: number;
    dependencies: Record<string, string>;
    stats: Record<string, unknown>;
  };
}

interface ListNodesRequest extends NexxusHubApiRequest {
  query: { role?: string };
}

interface DeleteNodeRequest extends NexxusHubApiRequest {
  params: { id: string };
}

/**
 * Node registry endpoints. All node -> Hub traffic, so the whole subtree is
 * guarded by the shared-secret `Nxx-Hub-Token` header.
 *
 *   POST   /node             register (upsert on nodeId)
 *   DELETE /node/:nodeId     de-register (204 either way, idempotent)
 *   GET    /node[?role=...]  list registered nodes, optionally filtered by role
 */
export default class NodeRoute extends NexxusHubApiBaseRoute {
  constructor(appRouter: Router) {
    super('/node', appRouter);
  }

  protected registerRoutes(): void {
    this.router.use(HubTokenMiddleware);

    this.router.post('/', this.registerNode.bind(this));
    this.router.delete('/:id', this.deregisterNode.bind(this));
    this.router.get('/', this.listNodes.bind(this));
  }

  private registerNode(req: RegisterNodeRequest, res: Response): void {
    const { id, role, privateIpAddress, managementPort, dependencies, stats } = req.body;

    if (typeof id !== 'string' || id.length === 0) {
      throw new InvalidParametersException('"id" is required and must be a non-empty string');
    }

    if (typeof role !== 'string' || role.length === 0) {
      throw new InvalidParametersException('"role" is required and must be a non-empty string');
    }

    if (typeof privateIpAddress !== 'string' || privateIpAddress.length === 0) {
      throw new InvalidParametersException('"privateIpAddress" is required and must be a non-empty string');
    }

    if (typeof managementPort !== 'number' || !Number.isFinite(managementPort) || managementPort <= 0) {
      throw new InvalidParametersException('"managementPort" is required and must be a finite positive number');
    }

    if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
      throw new InvalidParametersException('"dependencies" is required and must be an object');
    }

    if (typeof stats !== 'object' || stats === null || Array.isArray(stats)) {
      throw new InvalidParametersException('"stats" is required and must be an object');
    }

    const record = NexxusHubApi.registry.upsert(
      {
        id,
        role,
        privateIpAddress,
        managementPort,
        dependencies,
        stats
      },
      Date.now()
    );

    // Kick off this node's per-node stats-refresh interval (starts at registration).
    NexxusHubApi.startManagedRefresh(record);

    res.status(200).json(record);
  }

  private deregisterNode(req: DeleteNodeRequest, res: Response): void {
    // dropNode removes from the registry AND stops the node's refresh timer.
    NexxusHubApi.dropNode(req.params.id);

    // Idempotent: 204 whether the id existed or not.
    res.status(204).end();
  }

  private listNodes(req: ListNodesRequest, res: Response): void {
    const role = typeof req.query.role === 'string' ? req.query.role : undefined;

    res.status(200).json(NexxusHubApi.registry.list(role));
  }
}
