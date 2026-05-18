import { Module } from '@nestjs/common';

import { SprintRetroService } from './retro.service';
import { SprintsController } from './sprints.controller';
import { SprintsService } from './sprints.service';

@Module({
  controllers: [SprintsController],
  providers: [SprintsService, SprintRetroService],
  exports: [SprintsService, SprintRetroService],
})
export class SprintsModule {}
