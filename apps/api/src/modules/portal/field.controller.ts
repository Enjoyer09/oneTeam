/**
 * oneTeam — Field API routes
 *
 * Consumed by the Telegram bot. Authenticated with the same bearer scheme as
 * everything else; see the note in field.service.ts about why the acting user
 * arrives as a chatId rather than as the caller's own identity.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { FieldService } from './field.service';
import { AuthGuard } from '../../common/auth/auth.guard';

@Controller('api/portal/field')
@UseGuards(AuthGuard)
export class FieldController {
  constructor(private readonly fieldService: FieldService) {}

  @Get('store')
  getStore(@Query('code') code?: string) {
    if (!code) throw new BadRequestException('code parametri tələb olunur');
    const store = this.fieldService.getStoreByCode(code);
    return { success: true, data: store };
  }

  @Get('session')
  getSession(@Query('chatId') chatId?: string) {
    if (!chatId) throw new BadRequestException('chatId parametri tələb olunur');
    return this.fieldService.session(chatId);
  }

  @Post('bind')
  @HttpCode(HttpStatus.OK)
  bind(@Body() body: { chatId: string | number; fullName?: string; storeId?: string }) {
    if (body?.chatId === undefined || body.chatId === null || body.chatId === '') {
      throw new BadRequestException('chatId tələb olunur');
    }
    return this.fieldService.bind(
      body.chatId,
      body.fullName || 'Sahə işçisi',
      body.storeId
    );
  }

  @Get('tasks')
  getTasks(@Query('storeId') storeId?: string) {
    if (!storeId) throw new BadRequestException('storeId parametri tələb olunur');
    const data = this.fieldService.getTasksForStore(storeId);
    return { success: true, data, total: data.length };
  }

  @Get('tasks/:id')
  getTaskById(@Param('id') id: string) {
    const task = this.fieldService.getTaskById(id);
    if (!task) {
      return { success: false, data: null, message: `Tapşırıq tapılmadı: ${id}` };
    }
    return { success: true, data: task };
  }

  @Post('tasks/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  async acknowledge(@Param('id') id: string, @Body() body: { chatId?: string | number }) {
    if (body?.chatId === undefined || body.chatId === null || body.chatId === '') {
      throw new BadRequestException('chatId tələb olunur');
    }
    return this.fieldService.acknowledgeTask(body.chatId, id);
  }

  @Get('submissions')
  getSubmissions(@Query('chatId') chatId?: string, @Query('limit') limit?: string) {
    if (!chatId) throw new BadRequestException('chatId parametri tələb olunur');
    const data = this.fieldService.getSubmissionsForChat(chatId, limit ? Number(limit) : 5);
    return { success: true, data, total: data.length };
  }

  @Post('submissions')
  @HttpCode(HttpStatus.CREATED)
  async submitSubmission(@Body() body: any) {
    if (body?.chatId === undefined || body.chatId === null || body.chatId === '') {
      throw new BadRequestException('chatId tələb olunur');
    }
    if (!body?.storeTaskId) {
      throw new BadRequestException('storeTaskId tələb olunur');
    }
    if (!body?.photoUrl) {
      throw new BadRequestException('photoUrl tələb olunur');
    }
    return this.fieldService.submitSubmission(body);
  }
}
