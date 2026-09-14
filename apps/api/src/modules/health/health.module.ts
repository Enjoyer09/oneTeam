import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { StorageModule } from '../storage/storage.module';

/**
 * Imports StorageModule so the health endpoint can report where photos go.
 *
 * That is worth a module dependency. The storage driver is chosen once from the
 * environment and is otherwise invisible — an operator who set `STORAGE_DRIVER=s3`
 * and misspelled a credential would get a working API that quietly keeps images
 * in the database, and nothing outside the start-up log would say so.
 */
@Module({
  imports: [StorageModule],
  controllers: [HealthController],
})
export class HealthModule {}
