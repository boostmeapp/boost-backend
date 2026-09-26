import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : { message: 'Internal server error' };

    // Machine-readable reason, e.g. { code: 'CALLEE_BUSY' }, so clients can pick
    // the right copy without parsing the message.
    const code =
      typeof message === 'object' && typeof (message as any).code === 'string'
        ? (message as any).code
        : undefined;

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message:
        typeof message === 'string'
          ? message
          : (message as any).message || 'An error occurred',
      ...(code && { code }),
    };

    // 4xx is the client's problem and often expected (e.g. accepting a call
    // the caller just cancelled → 409): one warn line, no stack. Only 5xx is
    // a server fault worth an error with its stack.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : 'Unknown error',
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} ${status}${code ? ` ${code}` : ''}: ${errorResponse.message}`,
      );
    }

    response.status(status).json(errorResponse);
  }
}
