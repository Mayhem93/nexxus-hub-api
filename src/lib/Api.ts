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
  resolveFactoryServiceClass
  // NexxusConstructableServiceClass,       // DB/MQ deferred
  // resolveConstructableServiceClass       // DB/MQ deferred
} from '@mayhem93/nexxus-core-lib';
// DB/MQ deferred to a future version — see NexxusHubApiConfig / constructor notes.
// import {
//   NexxusDatabaseAdapter,
//   NexxusDatabaseAdapterEvents,
//   NexxusElasticsearchDb
// } from '@mayhem93/nexxus-database-lib';
// import {
//   NexxusMessageQueueAdapter,
//   NexxusMessageQueueAdapterEvents,
//   NexxusRabbitMq
// } from '@mayhem93/nexxus-message-queue-lib';
import {
  RootRoute,
  NodeRoute
} from './routes/index.ts';
import { NodeRegistry } from './NodeRegistry.ts';
import {
  NotFoundMiddleware,
  ErrorMiddleware,
  RequestLoggerMiddleware
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
  /** Shared secret nodes present in the `Nxx-Hub-Token` header. */
  token: string;
  ssl?: {
    sslKeyPath: string;
    sslCertPath: string;
  };
} & NexxusConfig;

// DB/MQ are deferred to a future version — Hub v1 is a self-contained HTTP
// server with an in-memory registry. When they come back, restore the
// `database` / `messageQueue` members here (see the commented static fields
// and constructor checks below).
type ApiServices = INexxusBaseServices;

export interface NexxusHubApiRequest extends Express.Request {
  headers: IncomingHttpHeaders;
}

export class NexxusHubApi extends NexxusBaseService<NexxusHubApiConfig, {} , Record<string, any>> {
  public static logger: NexxusBaseLogger<any>;
  // DB/MQ deferred — restore when they're wired back in.
  // public static database: NexxusDatabaseAdapter<NexxusConfig, NexxusDatabaseAdapterEvents>;
  // public static messageQueue: NexxusMessageQueueAdapter<NexxusConfig, NexxusMessageQueueAdapterEvents>;
  public static instance: NexxusHubApi;

  /** Shared secret expected in the `Nxx-Hub-Token` header; read by HubTokenMiddleware. */
  public static hubToken: string;
  /** In-memory node registry. Lives for the lifetime of the Hub process. */
  public static readonly registry: NodeRegistry = new NodeRegistry();

  public static readonly loggerLabel: Readonly<string> = 'NexxusHubApi';
  private express: Express.Express;
  private server : HttpServer | https.Server | null = null;
  private httpsServer?: https.Server;
  protected static cliArgs: ConfigCliArgs = [];
  protected static envVars: ConfigEnvVars = [];

  protected static configRootKey: string = 'app';
  protected static schemaPath: string = path.join(process.cwd(), './src/schemas/api.schema.json');

  private static readonly builtinFactoryServices: Record<string, NexxusFactoryServiceClass> = {
    [WinstonNexxusLogger.name]: WinstonNexxusLogger,
  };

/*   private static readonly builtinConstructableServices: Record<string, NexxusConstructableServiceClass> = {
    [NexxusElasticsearchDb.name]: NexxusElasticsearchDb,
    [NexxusRabbitMq.name]:        NexxusRabbitMq,
  }; */

  constructor(services: ApiServices) {
    super(services.configManager.getConfig('app') as NexxusHubApiConfig);

    if (!(services.logger instanceof NexxusBaseLogger)) {
      throw new FatalErrorException('Logger service is not an instance of NexxusBaseLogger');
    }

    // DB/MQ deferred — restore these checks/assignments when they're wired back in.
    // if (!(services.database instanceof NexxusDatabaseAdapter)) {
    //   throw new FatalErrorException('Database service is not an instance of NexxusDatabaseAdapter');
    // }
    // if (!(services.messageQueue instanceof NexxusMessageQueueAdapter)) {
    //   throw new FatalErrorException('Message Queue service is not an instance of NexxusMessageQueueAdapter');
    // }

    NexxusHubApi.logger = services.logger;
    NexxusHubApi.hubToken = this.config.token;
    // NexxusHubApi.database = services.database;
    // NexxusHubApi.messageQueue = services.messageQueue;

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

  public init(): Promise<void> {
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

    new RootRoute(this.express);
    new NodeRoute(this.express);

    this.express.use(NotFoundMiddleware);
    this.express.use(ErrorMiddleware);

    if (this.config.ssl !== undefined && this.httpsServer) {
      this.server = this.httpsServer;

      this.httpsServer.listen(this.config.port);
    } else {
      this.server = this.express.listen(this.config.port);
    }

    return new Promise<void>((resolve, reject) => {
      this.server?.once('error', (err: Error) => {
        NexxusHubApi.logger.error(`API service failed to start: ${err.message}`, { name: err.name, stack: err.stack }, NexxusHubApi.loggerLabel);

        reject(err);
      });

      this.server?.once('listening', () => {
        NexxusHubApi.logger.info(`API service is listening on port ${this.config.port}`, NexxusHubApi.loggerLabel);

        resolve();
      });
    });
  }

  public async close(): Promise<void> {
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
/*   public static async resolveConstructableService(
    configManager: NexxusConfigManager,
    configuredName: string
  ): Promise<NexxusConstructableServiceClass> {
    const cls = await resolveConstructableServiceClass(configuredName, NexxusHubApi.builtinConstructableServices);

    configManager.registerService(cls);

    return cls;
  } */

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
