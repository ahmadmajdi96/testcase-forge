import { buildApp } from './api/app.js';
import { loadEnv } from './config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { app, logger } = await buildApp(env);

  const close = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled rejection');
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    logger.info(
      { port: env.PORT, model: env.NOVITA_MODEL, authEnabled: env.apiKeys.length > 0 },
      'testcase-forge listening',
    );
  } catch (error) {
    logger.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

void main();
