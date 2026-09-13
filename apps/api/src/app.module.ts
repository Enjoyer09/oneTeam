import { Module } from '@nestjs/common';
import { TasksModule } from './modules/tasks/tasks.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { EvidencesModule } from './modules/evidences/evidences.module';
import { HealthModule } from './modules/health/health.module';
import { PortalModule } from './modules/portal/portal.module';
import { AuthGuard } from './common/auth/auth.guard';

@Module({
  imports: [HealthModule, TasksModule, NotificationsModule, EvidencesModule, PortalModule],
  controllers: [],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AppModule {}
