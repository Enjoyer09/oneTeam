import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  Request,
  UseGuards,
} from '@nestjs/common';
import { StateTransitionRequestDto, BulkDispatchDto } from '@oneteam/types';
import { TaskStateService } from './task-state.service';
import { db } from '@oneteam/database';
import { AuthGuard, getPrincipal } from '../../common/auth/auth.guard';
import { AuthenticatedPrincipal } from '../../common/auth/authenticated-principal';
import { Request as ExpressRequest } from 'express';

@Controller('api/tasks')
@UseGuards(AuthGuard)
export class TasksController {
  constructor(private readonly taskStateService: TaskStateService) {}

  @Post('bulk-dispatch')
  @HttpCode(HttpStatus.CREATED)
  async bulkDispatch(
    @Body() dto: BulkDispatchDto,
    @Request() request: ExpressRequest & { principal?: AuthenticatedPrincipal },
  ) {
    return this.taskStateService.bulkDispatchTasks(dto, getPrincipal(request));
  }

  @Get()
  getAllTasks(@Request() request: ExpressRequest & { principal?: AuthenticatedPrincipal }) {
    const principal = getPrincipal(request);
    const tasks = db.getTasksForUser(principal.userId, principal.role);
    return {
      success: true,
      data: tasks,
      total: tasks.length,
    };
  }

  @Get(':id')
  getTaskById(
    @Param('id') id: string,
    @Request() request: ExpressRequest & { principal?: AuthenticatedPrincipal },
  ) {
    const principal = getPrincipal(request);
    const task = db.getTask(id);
    if (!task) {
      return { success: false, data: undefined };
    }
    if (!db.canUserAccessTask(principal.userId, principal.role, id)) {
      return { success: false, data: undefined };
    }
    return {
      success: true,
      data: task,
    };
  }

  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  async transitionTask(
    @Param('id') id: string,
    @Body() dto: StateTransitionRequestDto,
    @Request() request: ExpressRequest & { principal?: AuthenticatedPrincipal },
  ) {
    return this.taskStateService.transitionTask(
      id,
      dto.targetState,
      getPrincipal(request),
      dto.notes,
    );
  }
}
