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
 * project's handlers rely on that shape — the field endpoints put their human
 * text in `error`, others use `message`, and the bot and panel parse both.
 * Rewriting an object response would be a silent contract change across three
 * clients, so `normalise` below passes every object through byte for byte.
 *
 * What it does fix is the other case: an `HttpException` built from a bare
 * string, which Nest emits as a bare JSON string with no fields on it at all.
 * See `normalise`.
 *
 * What it catches is the *other* kind: a raw `Error` (or anything else) that
 * escaped a handler. Without a filter that becomes a 500 whose body can carry a
 * stack trace or a database message — an internal detail leaking to the caller.
 * Here it becomes a flat, safe 500, and the real cause is logged server-side
 * where it belongs.
 */
/**
 * Gives every error response one shape.
 *
 * WHY
 * ---
 * 52 call sites throw `new HttpException('some Azerbaijani text', 400)` — a
 * bare string. NestJS serialises that as a bare JSON string, not an object:
 *
 *     "Son tarix düzgün formatda deyil (məsələn: 2026-09-30T18:00)"
 *
 * so the body has no `message` field at all. A client reading
 * `body.message` — or a test asserting the operator was told what shape to use
 * — finds `undefined`, and the person fixing a bad coordinate gets silence
 * instead of the sentence that explains the decimal point.
 *
 * The rest of the codebase already uses the object form
 * (`{ error: 'STORE_CODE_TAKEN', message: … }`), and 45 of the 47 error-shape
 * assertions in the suite read `.error`. So the string form was the outlier,
 * not the convention, and it was an outlier in a way that loses information:
 * the text is there in the response, but not where anything looks for it.
 *
 * Only strings are rewritten. An object response is passed through byte for
 * byte, because its `error` code is a contract the bot and the panel both
 * branch on, and nothing here should be able to change it by accident.
 */
function normalise(body: string | object, status: number): object {
  if (typeof body !== 'string') return body;

  if (body.length === 0) {
    return { success: false, error: defaultCode(status), message: defaultMessage(status) };
  }
  return {
    success: false,
    error: defaultCode(status),
    message: body,
  };
}

/** The code a string-form exception has no way to carry. */
function defaultCode(status: number): string {
  return (
    {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      429: 'TOO_MANY_REQUESTS',
      503: 'SERVICE_UNAVAILABLE',
    }[status] ?? 'ERROR'
  );
}

function defaultMessage(status: number): string {
  return (
    {
      400: 'Sorğu düzgün deyil.',
      401: 'Authentication required',
      403: 'İcazə yoxdur.',
      404: 'Tapılmadı.',
      409: 'Konflikt baş verdi.',
      429: 'Çox sayda sorğu göndərildi.',
      503: 'Xidmət müvəqqəti işləmir.',
    }[status] ?? 'Xəta baş verdi.'
  );
}

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
      response.status(status).json(normalise(exception.getResponse(), status));
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
