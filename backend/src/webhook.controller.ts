import { Body, Controller, Get, Param, Post, Res, HttpStatus, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { WebhookService, WebhookEvent } from './webhook.service';

@Controller()
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post('webhooks')
  async ingestWebhook(@Body() body: WebhookEvent, @Res() res: Response) {
    if (
      !body ||
      typeof body.eventId !== 'string' ||
      !body.eventId.trim() ||
      typeof body.type !== 'string' ||
      !body.type.trim() ||
      !body.data ||
      typeof body.data !== 'object' ||
      Array.isArray(body.data)
    ) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'eventId, type, and object data are required',
      });
    }

    const result = await this.webhookService.ingest(body);
    const status = result.duplicate ? HttpStatus.OK : HttpStatus.ACCEPTED;
    return res.status(status).json({
      accepted: true,
      eventId: body.eventId,
      duplicate: result.duplicate,
    });
  }

  @Get('api/events')
  async getEvents() {
    return this.webhookService.getEvents();
  }

  @Get('api/events/:eventId')
  async getEvent(@Param('eventId') eventId: string) {
    const event = await this.webhookService.getEvent(eventId);
    if (!event) throw new NotFoundException('Event not found');
    const attempts = await this.webhookService.getAttemptHistory(eventId);
    return { event, attempts };
  }

  @Get('api/stats')
  async getStats() {
    const stats = await this.webhookService.getStats();
    const processedOrders = await this.webhookService.getProcessedOrdersCount();
    return { ...stats, processedOrders };
  }

  @Post('api/events/:eventId/retry')
  async manualRetry(@Param('eventId') eventId: string, @Res() res: Response) {
    const success = await this.webhookService.manualRetry(eventId);
    if (!success) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Event not found or not in failed state',
      });
    }
    return res.status(HttpStatus.OK).json({ retried: true, eventId });
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }
}
