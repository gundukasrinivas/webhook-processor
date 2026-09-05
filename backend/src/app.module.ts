import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { WorkerService } from './worker.service';

@Module({
  controllers: [WebhookController],
  providers: [DatabaseService, WebhookService, WorkerService],
})
export class AppModule {}
