import {
  NexxusConfigManager,
  NexxusBaseLogger,
  FatalErrorException,
  type INexxusBaseServices,
} from '@mayhem93/nexxus-core-lib';
import { NexxusHubApi, type NexxusHubApiConfig } from './lib/Api.ts';

let logger: NexxusBaseLogger<any> | undefined;

(async () => {
  const configManager = new NexxusConfigManager();

  // Register the framework-fixed service (Hub API) so we can read `app.logger`.
  // DB/MQ are deferred in v1 — Hub is a self-contained HTTP server + in-memory registry.
  await configManager.validateServices([ NexxusHubApi ]);

  const apiConfig = configManager.getConfig('app') as NexxusHubApiConfig;

  const LoggerClass = await NexxusHubApi.resolveFactoryService(configManager, apiConfig.logger);

  // Validate the services registered by the resolveFactoryService call above.
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

  const api = new NexxusHubApi({ configManager, logger });

  await api.init();

  const shutdown = (): void => {
    api.close();
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
