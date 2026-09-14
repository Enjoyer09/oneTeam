import { Module } from '@nestjs/common';
import { PortalService } from './portal.service';
import { PortalController } from './portal.controller';
import { FieldService } from './field.service';
import { FieldController } from './field.controller';
import { EnrollmentController } from './enrollment.controller';
import { TasksModule } from '../tasks/tasks.module';
import { EvidencesModule } from '../evidences/evidences.module';
import { StorageModule } from '../storage/storage.module';
import { AuthGuard } from '../../common/auth/auth.guard';

/**
 * Imports TasksModule to reuse its exported TaskStateService rather than
 * reimplementing the state machine. Reviewing an audit is a task transition, and
 * duplicating the transition rules here is exactly how the panel and the mobile
 * flow would drift apart.
 *
 * EvidencesModule is imported for the same reason: the bot's submissions go
 * through the same EvidenceService the mobile client uses, so the geofence and
 * checklist rules have one implementation.
 *
 * StorageModule is where a submitted photo is offloaded to object storage when
 * one is configured. It sits here rather than in EvidencesModule because the
 * photo arrives over this API — EvidenceService receives a URL and never sees
 * the bytes.
 */
@Module({
  imports: [TasksModule, EvidencesModule, StorageModule],
  // EnrollmentController is separate from FieldController because it is the one
  // route that must NOT sit behind AuthGuard — its job is to issue the
  // credential the guard checks. See its file header.
  controllers: [PortalController, FieldController, EnrollmentController],
  providers: [PortalService, FieldService, AuthGuard],
  exports: [PortalService, FieldService],
})
export class PortalModule {}
