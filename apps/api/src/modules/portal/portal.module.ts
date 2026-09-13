import { Module } from '@nestjs/common';
import { PortalService } from './portal.service';
import { PortalController } from './portal.controller';
import { TasksModule } from '../tasks/tasks.module';
import { AuthGuard } from '../../common/auth/auth.guard';

/**
 * Imports TasksModule to reuse its exported TaskStateService rather than
 * reimplementing the state machine. Reviewing an audit is a task transition, and
 * duplicating the transition rules here is exactly how the panel and the mobile
 * flow would drift apart.
 */
@Module({
  imports: [TasksModule],
  controllers: [PortalController],
  providers: [PortalService, AuthGuard],
  exports: [PortalService],
})
export class PortalModule {}
