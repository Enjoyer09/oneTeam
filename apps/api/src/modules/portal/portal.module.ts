import { Module } from '@nestjs/common';
import { PortalService } from './portal.service';
import { PortalController } from './portal.controller';
import { PanelAuthController } from './panel-auth.controller';
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
  // Three controllers, and the difference between them is what stands in front:
  //
  //   PortalController     — everything behind AuthGuard. The panel's data.
  //   FieldController      — AuthGuard plus an actor-scope check, because these
  //                          routes are called by devices.
  //   EnrollmentController — deliberately NOT behind AuthGuard: its job is to
  //                          issue the credential the guard checks.
  //   PanelAuthController  — mixed, and that is why the guard is applied per
  //                          route rather than to the class. `auth-status` has
  //                          to be public: the caller asking "do I need a key"
  //                          is by definition the caller who has not got one.
  controllers: [PortalController, PanelAuthController, FieldController, EnrollmentController],
  providers: [PortalService, FieldService, AuthGuard],
  exports: [PortalService, FieldService],
})
export class PortalModule {}
