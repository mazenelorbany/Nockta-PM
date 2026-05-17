import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OutboundWebhooksController } from './outbound-webhooks.controller';
import { OutboundWebhookProcessor } from './outbound-webhooks.processor';
import {
  OUTBOUND_WEBHOOKS_QUEUE,
  OutboundWebhooksService,
} from './outbound-webhooks.service';

// =============================================================================
// OutboundWebhooksModule — workspace-level webhook fan-out.
//
// Wires:
//   - the BullMQ queue (the custom backoff strategy is on the @Processor
//     decorator in outbound-webhooks.processor.ts so it lives next to the
//     schedule constants)
//   - the listener (lives inside the service as onAny in onModuleInit)
//   - the CRUD controller + service
//   - the delivery processor
//
// The service exports nothing for now — other modules talk to it ONLY via
// the event bus. If a future caller needs to drive a delivery directly,
// add the export at that point.
// =============================================================================

@Module({
  imports: [BullModule.registerQueue({ name: OUTBOUND_WEBHOOKS_QUEUE })],
  controllers: [OutboundWebhooksController],
  providers: [OutboundWebhooksService, OutboundWebhookProcessor],
  // Nothing exported intentionally — the boundary is the event bus.
})
export class OutboundWebhooksModule {}
