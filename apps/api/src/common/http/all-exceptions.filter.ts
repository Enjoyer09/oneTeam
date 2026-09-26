import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * The one place an unhandled error becomes an HTTP response.
 *
 * WHY THIS IS DELIBERATELY NARROW
 * -------------------------------
 * NestJS already turns an `HttpException` into a well-formed response, and this
 * project's handlers rely on that exact shape — the field endpoints put their
 * human text in `error`, others use `message`, and the bot and panel parse both.
 * Rewriting those would be a silent contract change across three clients, so
 * this filter leaves every `HttpException` untouched and re-throws it to the
 * default handling.
 *
 * What it catches is the *other* kind: a raw `Error` (or anything else) that
 * escaped a handler. Without a filter that becomes a 500 whose body can carry a
 * stack trace or a database message — an internal detail leaking to the caller.
 * Here it becomes a flat, safe 500, and the real cause is logged server-side
 * where it belongs.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('UnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Understood errors keep their existing, client-relied-upon shape.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json(exception.getResponse());
      return;
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    this.logger.error(
      `⛔ Unhandled error on ${request.method} ${request.url}: ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      // Never the real message: it can carry a stack or a database detail.
      message: 'Daxili server xətası baş verdi.',
    });
  }
}
