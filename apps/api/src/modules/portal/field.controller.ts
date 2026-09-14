/**
 * oneTeam — Field API routes
 * ============================================================================
 *
 * Consumed by the Telegram bot and by the mobile field client. Both
 * authenticate with the same bearer scheme as everything else; see the note in
 * field.service.ts about why the acting person arrives as a channel key
 * (`chatId` for a chat, `deviceId` for a device) rather than as the caller's own
 * identity.
 *
 * One set of endpoints for both channels is deliberate. A store that looks
 * different in the bot than in the mobile app, or a task that can be submitted
 * from one and not the other, is a bug class rather than a possibility — there is
 * only one code path to keep correct.
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
import { FieldService, FieldActorKey } from './field.service';
import { AuthGuard } from '../../common/auth/auth.guard';

/** Reads the acting person's channel key off a request body. */
function actorKeyFrom(body: any): FieldActorKey {
  return { chatId: body?.chatId, deviceId: body?.deviceId };
}

/** Reads the acting person's channel key off a query string. */
function actorKeyFromQuery(chatId?: string, deviceId?: string): FieldActorKey {
  return { chatId, deviceId };
}

/** Both endpoints need this, and both must reject the same malformed input. */
function requireActorKey(key: FieldActorKey): FieldActorKey {
  const hasChatId = key.chatId !== undefined && key.chatId !== null && key.chatId !== '';
  if (!hasChatId && !key.deviceId) {
    throw new BadRequestException('chatId və ya deviceId tələb olunur');
  }
  return key;
}

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
  getSession(@Query('chatId') chatId?: string, @Query('deviceId') deviceId?: string) {
    return this.fieldService.session(requireActorKey(actorKeyFromQuery(chatId, deviceId)));
  }

  @Post('bind')
  @HttpCode(HttpStatus.OK)
  bind(
    @Body()
    body: {
      chatId?: string | number;
      deviceId?: string;
      fullName?: string;
      storeId?: string;
    }
  ) {
    const key = requireActorKey(actorKeyFrom(body));
    return this.fieldService.bind(key, body.fullName || 'Sahə işçisi', body.storeId);
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
  async acknowledge(
    @Param('id') id: string,
    @Body() body: { chatId?: string | number; deviceId?: string }
  ) {
    return this.fieldService.acknowledgeTask(requireActorKey(actorKeyFrom(body)), id);
  }

  @Get('submissions')
  getSubmissions(
    @Query('chatId') chatId?: string,
    @Query('deviceId') deviceId?: string,
    @Query('limit') limit?: string
  ) {
    const key = requireActorKey(actorKeyFromQuery(chatId, deviceId));
    const data = this.fieldService.getSubmissions(key, limit ? Number(limit) : 5);
    return { success: true, data, total: data.length };
  }

  @Post('submissions')
  @HttpCode(HttpStatus.CREATED)
  async submitSubmission(@Body() body: any) {
    requireActorKey(actorKeyFrom(body));
    if (!body?.storeTaskId) {
      throw new BadRequestException('storeTaskId tələb olunur');
    }
    if (!body?.photoUrl) {
      throw new BadRequestException('photoUrl tələb olunur');
    }
    return this.fieldService.submitSubmission(body);
  }
}
