import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private readonly workerId: string;
  private running = false;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(private readonly webhookService: WebhookService) {
    this.workerId = process.env.WORKER_ID || `worker-${uuidv4().slice(0, 8)}`;
  }

  async onModuleInit() {
    if (process.env.ENABLE_WORKER === 'true') {
      this.start();
    }
  }

  onModuleDestroy() {
    this.stop();
  }

  start() {
    this.running = true;
    this.logger.log(`Worker ${this.workerId} starting`);
    this.poll();
  }

  stop() {
    this.running = false;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
    this.logger.log(`Worker ${this.workerId} stopped`);
  }

  private async poll() {
    if (!this.running) return;

    try {
      const event = await this.webhookService.claimEvent(this.workerId);
      if (event) {
        this.logger.log(`Worker ${this.workerId} claimed event ${event.event_id}`);
        await this.webhookService.processEvent(event, this.workerId);
        // Immediately poll again after processing
        if (this.running) {
          setImmediate(() => this.poll());
          return;
        }
      }
    } catch (err) {
      this.logger.error(`Worker ${this.workerId} error: ${err.message}`);
    }

    // No event found or error — wait before polling again
    if (this.running) {
      const pollMs = parseInt(process.env.POLL_INTERVAL_MS || '1000');
      this.pollInterval = setTimeout(() => this.poll(), pollMs);
    }
  }
}
