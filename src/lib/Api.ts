import {
  FatalErrorException,
  ConfigCliArgs,
  ConfigEnvVars,
  NexxusBaseService,
  NexxusConfig,
  NexxusBaseLogger,
  INexxusBaseServices,
  WinstonNexxusLogger,
  NexxusConfigManager,
  NexxusFactoryServiceClass,
  NexxusConstructableServiceClass,
  resolveFactoryServiceClass,
  resolveConstructableServiceClass
} from '@mayhem93/nexxus-core-lib';
import {
  NexxusDatabaseAdapter,
  NexxusDatabaseAdapterEvents,
  NexxusElasticsearchDb
} from '@mayhem93/nexxus-database-lib';
import {
  NexxusMessageQueueAdapter,
  NexxusMessageQueueAdapterEvents,
  NexxusMessageQueueAdapterStats,
  NexxusRabbitMq
} from '@mayhem93/nexxus-message-queue-lib';
import { NexxusRedis } from '@mayhem93/nexxus-redis';
import {
  RootRoute,
  NodeRoute,
  SettingRoute
} from './routes/index.ts';
import { NodeRegistry, type NodeRecord } from './NodeRegistry.ts';
import {
  NotFoundMiddleware,
  ErrorMiddleware,
  RequestLoggerMiddleware,
  HubTokenMiddleware
} from './middlwares/index.ts';

import Express from 'express';
import helmet from 'helmet';

import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { IncomingHttpHeaders, Server as HttpServer } from 'node:http';
import https from 'node:https';

export type NexxusHubApiConfig = {
  name: string;
  port: number;
  logger: string;
  /** Class name of the database adapter (e.g. `NexxusElasticsearchDb`). */
  database: string;
  /** Class name of the message-queue adapter (e.g. `NexxusRabbitMq`). */
  message_queue: string;
  /** Shared secret nodes present in the `Nxx-Hub-Token` header. */
  token: string;
  maxPollFailures: number;
  refreshIntervalMs: number;
  ssl?: {
    sslKeyPath: string;
    sslCertPath: string;
  };
} & NexxusConfig;

interface ApiServices extends INexxusBaseServices {
  database: NexxusDatabaseAdapter<NexxusConfig, NexxusDatabaseAdapterEvents>;
  messageQueue: NexxusMessageQueueAdapter<NexxusConfig, NexxusMessageQueueAdapterEvents, NexxusMessageQueueAdapterStats>;
  redis: NexxusRedis;
};

export interface NexxusHubApiRequest extends Express.Request {
  headers: IncomingHttpHeaders;
}

/**
 * Minimal shape Hub needs from each infra service to register it as a node:
 * an `id`-carrying `getStats()` snapshot and a `disconnect` event to auto-drop
 * it. The concrete adapters (DB/MQ/Redis) all satisfy this; the base adapter
 * generics don't encode the `id`, so it's typed optional here.
 */
interface InfraNodeService {
  getStats(): Promise<{ id?: string } & Record<string, unknown>>;
  on(event: 'disconnect', listener: () => void): unknown;
}

export class NexxusHubApi extends NexxusBaseService<NexxusHubApiConfig, {} , Record<string, any>> {
  public static logger: NexxusBaseLogger<any>;
  public static database: NexxusDatabaseAdapter<NexxusConfig, NexxusDatabaseAdapterEvents>;
  public static messageQueue: NexxusMessageQueueAdapter<NexxusConfig, NexxusMessageQueueAdapterEvents, NexxusMessageQueueAdapterStats>;
  public static redis: NexxusRedis;
  public static instance: NexxusHubApi;

  /** Shared secret expected in the `Nxx-Hub-Token` header; read by HubTokenMiddleware. */
  public static hubToken: string;
  /** In-memory node registry. Lives for the lifetime of the Hub process. */
  public static readonly registry: NodeRegistry = new NodeRegistry();

  /** Per-node refresh timers, keyed by node id. One `setInterval` per node, started at registration. */
  private static readonly refreshTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Consecutive HTTP poll failures per node id; reset on success, cleared on removal. */
  private static readonly pollFailures: Map<string, number> = new Map();

  public static readonly loggerLabel: Readonly<string> = 'NexxusHubApi';
  private express: Express.Express;
  private server : HttpServer | https.Server | null = null;
  private httpsServer?: https.Server;
  /** Held so the infra-node registration can read each service's configured host. */
  private readonly configManager: NexxusConfigManager;
  protected static cliArgs: ConfigCliArgs = [];
  protected static envVars: ConfigEnvVars = [];

  protected static configRootKey: string = 'app';
  protected static schemaPath: string = path.join(process.cwd(), './src/schemas/api.schema.json');

  private static readonly builtinFactoryServices: Record<string, NexxusFactoryServiceClass> = {
    [WinstonNexxusLogger.name]: WinstonNexxusLogger,
  };

  private static readonly builtinConstructableServices: Record<string, NexxusConstructableServiceClass> = {
    [NexxusElasticsearchDb.name]: NexxusElasticsearchDb,
    [NexxusRabbitMq.name]:        NexxusRabbitMq,
  };

  constructor(services: ApiServices) {
    super(services.configManager.getConfig('app') as NexxusHubApiConfig);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new FatalErrorException('Logger service is not an instance of NexxusBaseLogger');
    }

    if (!(services.database instanceof NexxusDatabaseAdapter)) {
      throw new FatalErrorException('Database service is not an instance of NexxusDatabaseAdapter');
    }

    if (!(services.messageQueue instanceof NexxusMessageQueueAdapter)) {
      throw new FatalErrorException('Message Queue service is not an instance of NexxusMessageQueueAdapter');
    }

    if (!(services.redis instanceof NexxusRedis)) {
      throw new FatalErrorException('Redis service is not an instance of NexxusRedis');
    }

    NexxusHubApi.logger = services.logger;
    NexxusHubApi.database = services.database;
    NexxusHubApi.messageQueue = services.messageQueue;
    NexxusHubApi.redis = services.redis;
    NexxusHubApi.hubToken = this.config.token;

    this.configManager = services.configManager;

    this.express = Express();
    this.express.disable("x-powered-by");

    if (this.config.ssl !== undefined) {
      this.httpsServer = https.createServer({
        key: readFileSync(this.config.ssl.sslKeyPath),
        cert: readFileSync(this.config.ssl.sslCertPath)
      }, this.express);
    }

    NexxusHubApi.instance = this;
  }

  public async init(): Promise<void> {
    NexxusHubApi.logger.info('Initializing API service...', NexxusHubApi.loggerLabel);

    this.express.use(RequestLoggerMiddleware as Express.RequestHandler);

    this.express.use(helmet({
      xDownloadOptions: false,
      xXssProtection: false,
      xDnsPrefetchControl: false,
      xFrameOptions: false,
      originAgentCluster: false,
      referrerPolicy: { policy: 'same-origin' },
      strictTransportSecurity: this.config.ssl !== undefined ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      } : false
    }));
    this.express.use(Express.json());
    this.express.use(Express.urlencoded({ extended: true }));

    // Every route sits behind the shared-secret Nxx-Hub-Token check.
    this.express.use(HubTokenMiddleware);

    new RootRoute(this.express);
    new NodeRoute(this.express);
    new SettingRoute(this.express);

    this.express.use(NotFoundMiddleware);
    this.express.use(ErrorMiddleware);

    if (this.config.ssl !== undefined && this.httpsServer) {
      this.server = this.httpsServer;

      this.httpsServer.listen(this.config.port);
    } else {
      this.server = this.express.listen(this.config.port);
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', (err: Error) => {
        NexxusHubApi.logger.error(`API service failed to start: ${err.message}`, { name: err.name, stack: err.stack }, NexxusHubApi.loggerLabel);

        reject(err);
      });

      this.server?.once('listening', () => {
        NexxusHubApi.logger.info(`API service is listening on port ${this.config.port}`, NexxusHubApi.loggerLabel);

        resolve();
      });
    });

    await this.registerInfraNodes();
  }

  /**
   * Registers Hub's own infra connections (DB, MQ, Redis) as nodes in the
   * registry, so `GET /node` lists them alongside API/worker nodes. Each record
   * is keyed on the `id` from that service's `getStats()` snapshot, and the
   * snapshot itself becomes `stats`. A `disconnect` event (fired when the
   * connection drops) removes the node again — reliable liveness, since Hub
   * holds these connections directly.
   *
   * NOTE: the Elasticsearch adapter never fires `disconnect` today (stateless
   * HTTP client), so its entry only clears on Hub restart. Acceptable for now.
   */
  private async registerInfraNodes(): Promise<void> {
    const now = Date.now();

    await this.registerInfraNode(NexxusHubApi.database, 'database', now);
    await this.registerInfraNode(NexxusHubApi.messageQueue, 'message_queue', now);
    await this.registerInfraNode(NexxusHubApi.redis, 'redis', now);
  }

  private async registerInfraNode(service: InfraNodeService, role: string, now: number): Promise<void> {
    const stats = await service.getStats();
    const id = stats.id ?? 'unknown';
    // `role` doubles as the top-level config key (database / message_queue / redis),
    // so the service's configured host is the most meaningful private address.
    const host = (this.configManager.getConfig(role) as { host?: string })?.host ?? 'unknown';

    NexxusHubApi.registry.upsert(
      {
        id,
        role,
        privateIpAddress: host,
        dependencies: {},
        stats,
      },
      now
    );

    NexxusHubApi.logger.info(`Registered infra node "${role}" (${id})`, NexxusHubApi.loggerLabel);

    // Infra nodes have no management server — refresh their stats in-process by
    // re-calling the local adapter's getStats(). Removal stays driven by the
    // `disconnect` event (a reliable local signal), so no failure-counting here.
    NexxusHubApi.startInfraRefresh(id, service);

    service.on('disconnect', () => {
      NexxusHubApi.dropNode(id);
      NexxusHubApi.logger.info(`Infra node "${role}" (${id}) disconnected — removed from registry`, NexxusHubApi.loggerLabel);
    });
  }

  /**
   * Start the periodic in-process stats refresh for an infra node (DB/MQ/Redis).
   * `getStats()` on these adapters resolves even when the backend is down
   * (returning `{ connected: false }`), so this never throws into a
   * failure-removal path — that's what the `disconnect` event is for.
   * Idempotent: clears any existing timer for the id first.
   */
  private static startInfraRefresh(id: string, service: InfraNodeService): void {
    NexxusHubApi.stopRefresh(id);

    const timer = setInterval(() => {
      void (async () => {
        try {
          const stats = await service.getStats();

          NexxusHubApi.registry.updateStats(id, stats);
        } catch (err) {
          NexxusHubApi.logger.warn(`Infra stats refresh failed for "${id}": ${(err as Error).message}`, NexxusHubApi.loggerLabel);
        }
      })();
    }, NexxusHubApi.instance.config.refreshIntervalMs);

    NexxusHubApi.refreshTimers.set(id, timer);
  }

  /**
   * Start the periodic HTTP stats refresh for a managed node (API/worker) that
   * advertised a `managementPort`. Polls the node's management `/stats`
   * endpoint (bearer-authed with the shared hub secret) and overwrites the
   * stored snapshot. After `MAX_POLL_FAILURES` consecutive failures the node is
   * dropped from the registry. Idempotent: clears any existing timer first.
   */
  public static startManagedRefresh(record: NodeRecord): void {
    if (record.managementPort === undefined) {
      return;
    }

    NexxusHubApi.stopRefresh(record.id);

    const timer = setInterval(() => {
      void NexxusHubApi.pollManagedNode(record.id, record.privateIpAddress, record.managementPort as number);
    }, NexxusHubApi.instance.config.refreshIntervalMs);

    NexxusHubApi.refreshTimers.set(record.id, timer);
  }

  private static async pollManagedNode(id: string, privateIpAddress: string, managementPort: number): Promise<void> {
    const url = `http://${privateIpAddress}:${managementPort}/stats`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${NexxusHubApi.hubToken}` },
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        throw new Error(`management /stats returned ${response.status}`);
      }

      const stats = await response.json() as Record<string, unknown>;

      NexxusHubApi.registry.updateStats(id, stats);
      NexxusHubApi.pollFailures.delete(id);
    } catch (err) {
      const failures = (NexxusHubApi.pollFailures.get(id) ?? 0) + 1;

      NexxusHubApi.pollFailures.set(id, failures);
      NexxusHubApi.logger.warn(
        `Stats poll failed for node "${id}" (${failures}/${NexxusHubApi.instance.config.maxPollFailures}): ${(err as Error).message}`,
        NexxusHubApi.loggerLabel
      );

      if (failures >= NexxusHubApi.instance.config.maxPollFailures) {
        NexxusHubApi.logger.warn(
          `Node "${id}" exceeded ${NexxusHubApi.instance.config.maxPollFailures} failed polls — removing from registry`,
          NexxusHubApi.loggerLabel
        );

        NexxusHubApi.dropNode(id);
      }
    }
  }

  /** Remove a node from the registry and stop its refresh timer. Idempotent. */
  public static dropNode(id: string): void {
    NexxusHubApi.stopRefresh(id);
    NexxusHubApi.registry.remove(id);
  }

  /** Clear a node's refresh timer + failure counter. Safe to call for an unknown id. */
  private static stopRefresh(id: string): void {
    const timer = NexxusHubApi.refreshTimers.get(id);

    if (timer) {
      clearInterval(timer);
      NexxusHubApi.refreshTimers.delete(id);
    }

    NexxusHubApi.pollFailures.delete(id);
  }

  /** Stop every refresh timer — called during shutdown so the process can exit. */
  private static stopAllRefresh(): void {
    for (const timer of NexxusHubApi.refreshTimers.values()) {
      clearInterval(timer);
    }

    NexxusHubApi.refreshTimers.clear();
    NexxusHubApi.pollFailures.clear();
  }

  public async close(): Promise<void> {
    NexxusHubApi.stopAllRefresh();

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((err?: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      NexxusHubApi.logger.info('API service has been closed', NexxusHubApi.loggerLabel);
    }

    return Promise.resolve();
  }

  /**
   * Resolves + registers a factory-style service (currently just the logger).
   * Config value is looked up in `builtinFactoryServices` first; a miss falls
   * through to dynamic import against the app's install tree. Registration is
   * batched — the next `configManager.validateServices()` call picks up the
   * resolved class's schema.
   */
  public static async resolveFactoryService(
    configManager: NexxusConfigManager,
    configuredName: string
  ): Promise<NexxusFactoryServiceClass> {
    const cls = await resolveFactoryServiceClass(configuredName, NexxusHubApi.builtinFactoryServices);

    configManager.registerService(cls);

    return cls;
  }

  /**
   * Resolves + registers a constructable service (database, message queue).
   * Same lookup-then-import shape as `resolveFactoryService`, minus the
   * `create()` requirement.
   */
  public static async resolveConstructableService(
    configManager: NexxusConfigManager,
    configuredName: string
  ): Promise<NexxusConstructableServiceClass> {
    const cls = await resolveConstructableServiceClass(configuredName, NexxusHubApi.builtinConstructableServices);

    configManager.registerService(cls);

    return cls;
  }

  public getStats(): Promise<Record<string, any>> {
    // Never expose the shared secret in stats.
    const { token: _token, ...safeConfig } = this.config;

    const stats: Record<string, any> = {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
      registeredNodes: NexxusHubApi.registry.size,
      config: safeConfig
    };

    return Promise.resolve(stats);
  }
}
