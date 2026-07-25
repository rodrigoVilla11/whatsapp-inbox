import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { MAINTENANCE_QUEUE } from '../queue/queue.constants';
import { RetentionModule } from '../retention/retention.module';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceScheduler } from './maintenance.scheduler';

@Module({
  imports: [
    BullModule.registerQueue({
      name: MAINTENANCE_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        removeOnComplete: { count: 30 },
        removeOnFail: { count: 90 },
      },
    }),
    RetentionModule,
    MediaModule, // MediaSweepService (barrido de media huérfana)
  ],
  providers: [MaintenanceProcessor, MaintenanceScheduler],
})
export class MaintenanceModule {}
