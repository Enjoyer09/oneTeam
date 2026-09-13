import { Module } from '@nestjs/common';
import { TasksModule } from './modules/tasks/tasks.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { EvidencesModule } from './modules/evidences/evidences.module';
import { AuthGuard } from './common/auth/auth.guard';

@Module({
  imports: [TasksModule, NotificationsModule, EvidencesModule],
  controllers: [],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AppModule {}
