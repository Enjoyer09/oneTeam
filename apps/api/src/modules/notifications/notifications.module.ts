import { Module, forwardRef } from '@nestjs/common';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { WebhookController } from './webhook.controller';
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [forwardRef(() => TasksModule)],
  controllers: [WebhookController],
  providers: [NotificationDispatcherService],
  exports: [NotificationDispatcherService],
})
export class NotificationsModule {}
