/**
 * oneTeam — Portal API
 * ============================================================================
 *
 * The endpoints the web panel talks to. Everything is behind AuthGuard, so a
 * request needs `Authorization: Bearer oneteam-user:<userId>` naming a real
 * user row — see nginx.conf, which attaches that header at the edge so the
 * credential never reaches the browser bundle.
 *
 * All responses use the `{ success, data }` envelope the panel already expects.
 */

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
import { PortalService } from './portal.service';
import { AuthGuard, getPrincipal } from '../../common/auth/auth.guard';
import { AuthenticatedPrincipal } from '../../common/auth/authenticated-principal';
import { Request as ExpressRequest } from 'express';

type AuthedRequest = ExpressRequest & { principal?: AuthenticatedPrincipal };

@Controller('api/portal')
@UseGuards(AuthGuard)
export class PortalController {
  constructor(private readonly portalService: PortalService) {}

  /** One call that returns everything the dashboard renders on first paint. */
  @Get('bootstrap')
  bootstrap(@Request() request: AuthedRequest) {
    return this.portalService.getBootstrap(getPrincipal(request));
  }

  @Get('stores')
  getStores() {
    const data = this.portalService.getStores();
    return { success: true, data, total: data.length };
  }

  @Get('tasks')
  getTasks() {
    const data = this.portalService.getTasks();
    return { success: true, data, total: data.length };
  }

  @Get('submissions')
  getSubmissions() {
    const data = this.portalService.getSubmissions();
    return { success: true, data, total: data.length };
  }

  @Get('metrics')
  getMetrics() {
    return { success: true, data: this.portalService.getMetrics() };
  }

  @Post('submissions/:id/review')
  @HttpCode(HttpStatus.OK)
  async reviewSubmission(
    @Param('id') id: string,
    @Body() body: { status: 'approved' | 'rejected'; feedback?: string },
    @Request() request: AuthedRequest,
  ) {
    return this.portalService.reviewSubmission(id, body, getPrincipal(request));
  }

  @Post('submissions/:id/auto-approve')
  @HttpCode(HttpStatus.OK)
  async autoApprove(@Param('id') id: string, @Request() request: AuthedRequest) {
    return this.portalService.autoApproveSubmission(id, getPrincipal(request));
  }

  @Post('tasks')
  @HttpCode(HttpStatus.CREATED)
  async createTask(@Body() body: any, @Request() request: AuthedRequest) {
    return this.portalService.createAndDispatch(body, getPrincipal(request));
  }
}
