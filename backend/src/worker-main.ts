import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Worker-only entry point. Starts the NestJS app without listening on HTTP.
 * The WorkerService starts automatically via onModuleInit when ENABLE_WORKER=true.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  // Keep the process alive
  process.on('SIGTERM', async () => {
    console.log('Worker received SIGTERM, shutting down...');
    await app.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('Worker received SIGINT, shutting down...');
    await app.close();
    process.exit(0);
  });

  console.log(`Worker process started (WORKER_ID=${process.env.WORKER_ID})`);
}
bootstrap();
