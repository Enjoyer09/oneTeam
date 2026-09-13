import { Module, forwardRef } from '@nestjs/common';
import { TaskStateService } from './task-state.service';
import { TasksController } from './tasks.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthGuard } from '../../common/auth/auth.guard';

@Module({
  imports: [forwardRef(() => NotificationsModule)],
  controllers: [TasksController],
  providers: [TaskStateService, AuthGuard],
  exports: [TaskStateService],
})
export class TasksModule {}
