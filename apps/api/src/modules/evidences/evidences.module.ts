import { Module } from '@nestjs/common';
import { EvidenceService } from './evidence.service';
import { EvidencesController } from './evidences.controller';
import { TasksModule } from '../tasks/tasks.module';
import { AuthGuard } from '../../common/auth/auth.guard';

@Module({
  imports: [TasksModule],
  controllers: [EvidencesController],
  providers: [EvidenceService, AuthGuard],
  exports: [EvidenceService],
})
export class EvidencesModule {}
