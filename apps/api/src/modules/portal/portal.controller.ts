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
  Patch,
  Delete,
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

  /**
   * Store writes.
   *
   * These live on `/api/portal/` next to `GET stores` rather than under
   * `/api/panel/` as the plan first sketched. The reason is that a store is
   * business data, not panel administration: `/api/panel/*` answers "who am I
   * and which keys may I hold", and splitting a store's read from its write
   * across two controllers would put one resource behind two credentials with
   * two sets of rules. Both prefixes are supervisor routes, so the security
   * boundary is identical — see `isSupervisorRoute` in auth.guard.ts.
   */
  @Post('stores')
  @HttpCode(HttpStatus.CREATED)
  async createStore(@Body() body: any, @Request() request: AuthedRequest) {
    return this.portalService.createStore(body, getPrincipal(request));
  }

  @Patch('stores/:id')
  @HttpCode(HttpStatus.OK)
  async updateStore(@Param('id') id: string, @Body() body: any, @Request() request: AuthedRequest) {
    return this.portalService.updateStore(id, body, getPrincipal(request));
  }

  @Delete('stores/:id')
  @HttpCode(HttpStatus.OK)
  async deleteStore(@Param('id') id: string, @Request() request: AuthedRequest) {
    return this.portalService.deleteStore(id, getPrincipal(request));
  }

  /**
   * Product (SKU) catalogue — wave 1.2 of the Shelf Map plan.
   *
   * Same controller, same credential as the store routes: a SKU is business
   * data, not panel administration, and the read must sit next to the write
   * so one resource is never behind two credentials with two sets of rules.
   */
  @Get('products')
  getProducts() {
    const data = this.portalService.getProducts();
    return { success: true, data, total: data.length };
  }

  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  async createProduct(@Body() body: any, @Request() request: AuthedRequest) {
    return this.portalService.createProduct(body, getPrincipal(request));
  }

  @Patch('products/:id')
  @HttpCode(HttpStatus.OK)
  async updateProduct(
    @Param('id') id: string,
    @Body() body: any,
    @Request() request: AuthedRequest,
  ) {
    return this.portalService.updateProduct(id, body, getPrincipal(request));
  }

  @Delete('products/:id')
  @HttpCode(HttpStatus.OK)
  async deleteProduct(@Param('id') id: string, @Request() request: AuthedRequest) {
    return this.portalService.deleteProduct(id, getPrincipal(request));
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

  /**
   * Task edits and deletes, next to the read for the same reason the store
   * writes are: a task is business data, not panel administration.
   *
   * `PATCH` rather than `PUT` because the form sends only what changed, and a
   * task's fields are split across two tables — the row's own deadline and
   * assignee, and the shared briefing behind it. See `PortalService.updateTask`.
   */
  @Patch('tasks/:id')
  @HttpCode(HttpStatus.OK)
  async updateTask(@Param('id') id: string, @Body() body: any, @Request() request: AuthedRequest) {
    return this.portalService.updateTask(id, body, getPrincipal(request));
  }

  @Delete('tasks/:id')
  @HttpCode(HttpStatus.OK)
  async deleteTask(@Param('id') id: string, @Request() request: AuthedRequest) {
    return this.portalService.deleteTask(id, getPrincipal(request));
  }
}
