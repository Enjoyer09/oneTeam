import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Photo storage, as its own module.
 *
 * Separate from `PortalModule` because the driver is chosen once from the
 * environment and never varies per request, and because the day a second
 * consumer needs it — a report exporter, a background retention job — it should
 * not have to reach into the field API to get it.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
