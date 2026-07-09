import {
  NexxusConfigManager,
  NexxusBaseLogger,
  FatalErrorException,
  type INexxusBaseServices,
} from '@mayhem93/nexxus-core-lib';
import { NexxusRedis } from '@mayhem93/nexxus-redis';
import { NexxusHubApi, type NexxusHubApiConfig } from './lib/Api.ts';
import type { NexxusDatabaseAdapter } from '@mayhem93/nexxus-database-lib';
import type { NexxusMessageQueueAdapter } from '@mayhem93/nexxus-message-queue-lib';

let logger: NexxusBaseLogger<any> | undefined;

(async () => {
  const configManager = new NexxusConfigManager();

  // Register the framework-fixed services (Hub API + Redis are not pluggable)
  // so we can read `app.logger` / `app.database` / `app.message_queue`.
  await configManager.validateServices([ NexxusHubApi, NexxusRedis ]);

  const apiConfig = configManager.getConfig('app') as NexxusHubApiConfig;

  const LoggerClass = await NexxusHubApi.resolveFactoryService(configManager, apiConfig.logger);
  const DbClass     = await NexxusHubApi.resolveConstructableService(configManager, apiConfig.database);
  const MqClass     = await NexxusHubApi.resolveConstructableService(configManager, apiConfig.message_queue);

  // Validate the rest of the services that were added through the resolveService calls above.
  await configManager.validateServices();

  // Logger services intentionally have no `logger` field — a logger can't
  // depend on itself. `NexxusFactoryServiceClass.create` types services as
  // full `INexxusBaseServices`, so cast at this one call site.
  const loggerInstance = await LoggerClass.create({ configManager } as INexxusBaseServices);

  if (!(loggerInstance instanceof NexxusBaseLogger)) {
    throw new FatalErrorException(
      `Class resolved for "${apiConfig.logger}" did not produce a NexxusBaseLogger instance.`
    );
  }

  logger = loggerInstance;

  const db    = new DbClass({ configManager, logger }) as NexxusDatabaseAdapter<any, any>;
  const mq    = new MqClass({ configManager, logger }) as NexxusMessageQueueAdapter<any, any, any>;
  const redis = new NexxusRedis({ configManager, logger });
  const api   = new NexxusHubApi({ configManager, logger, database: db, messageQueue: mq, redis });

  await db.connect();
  await mq.connect();
  await redis.init();
  await api.init();

  const shutdown = (): void => {
    api.close();
    mq.disconnect();
    db.disconnect();
    redis.close();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT',  shutdown);
})().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);

  if (logger) {
    logger.emerg(message, 'NxxHubApi');
  } else {
    console.error(message);
  }

  if (err instanceof FatalErrorException) {
    process.exit(1);
  }

  throw err;
});
