import { Module } from '@nestjs/common';

import { CfdSnapshotScheduler } from './cfd-snapshot.scheduler';
import { CfdSnapshotInvalidator } from './cfd-snapshot.invalidator';
import { DigestScheduler } from './digest.scheduler';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { WorkloadSnapshotScheduler } from './workload-snapshot.scheduler';

@Module({
  providers: [
    MaintenanceScheduler,
    DigestScheduler,
    WorkloadSnapshotScheduler,
    CfdSnapshotScheduler,
    CfdSnapshotInvalidator,
  ],
  exports: [CfdSnapshotScheduler],
})
export class MaintenanceModule {}
