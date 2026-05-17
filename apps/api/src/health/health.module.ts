import { Module } from '@nestjs/common';
import { StorageModule } from '../modules/storage/storage.module';
import { ConfigController } from './config.controller';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [StorageModule],
  controllers: [HealthController, MetricsController, ConfigController],
})
export class HealthModule {}
