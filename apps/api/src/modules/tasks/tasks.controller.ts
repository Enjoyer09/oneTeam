import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
    // A missing task, and a task this caller may not read, both answer 404 — not
    // an HTTP 200 with `success:false`, which lied about the outcome to every
    // client that checks the status line. The two cases are deliberately
    // indistinguishable: a distinct 403 would confirm the task exists to someone
    // not allowed to know that. The body still carries `success:false` for
    // clients that read it.
    if (!task || !db.canUserAccessTask(principal.userId, principal.role, id)) {
      throw new NotFoundException({
        success: false,
        error: 'TASK_NOT_FOUND',
        message: 'Tapşırıq tapılmadı və ya ona giriş yoxdur.',
      });
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
