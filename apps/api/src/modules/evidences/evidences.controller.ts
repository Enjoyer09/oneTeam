import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
  Request,
  UseGuards,
} from '@nestjs/common';
import { SubmitEvidenceRequestDto } from '@oneteam/types';
import { EvidenceService } from './evidence.service';
import { db } from '@oneteam/database';
import { AuthGuard, getPrincipal } from '../../common/auth/auth.guard';
import { AuthenticatedPrincipal } from '../../common/auth/authenticated-principal';
import { Request as ExpressRequest } from 'express';

@Controller('api/evidences')
@UseGuards(AuthGuard)
export class EvidencesController {
  constructor(private readonly evidenceService: EvidenceService) {}

  @Get()
  getAllEvidences(@Request() request: ExpressRequest & { principal?: AuthenticatedPrincipal }) {
    const principal = getPrincipal(request);
    const evidences = db.getEvidencesForUser(principal.userId, principal.role);
    return {
      success: true,
      data: evidences,
      total: evidences.length,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async submitEvidence(
    @Body() dto: SubmitEvidenceRequestDto,
    @Request() request: ExpressRequest & { principal?: AuthenticatedPrincipal },
  ) {
    return this.evidenceService.submitEvidence(dto, getPrincipal(request));
  }
}
