import { Module } from '@nestjs/common';
import { DeploymentWebhookController } from './deployment-webhook.controller';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';

@Module({
  controllers: [DeploymentWebhookController, DeploymentsController],
  providers: [DeploymentsService],
  exports: [DeploymentsService],
})
export class DeploymentsModule {}
