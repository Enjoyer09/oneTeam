import { Controller, Get } from '@nestjs/common';

/**
 * Liveness probe — deliberately unauthenticated.
 *
 * WHY THIS EXISTS
 * ---------------
 * The container healthcheck used to request `/api/tasks`. That route sits
 * behind AuthGuard and therefore answers 401 to every unauthenticated caller.
 * `wget --spider` treats any non-2xx response as a failure, so the healthcheck
 * reported the container as unhealthy while it was serving traffic correctly.
 *
 * That is not cosmetic. A platform that gates a release on its healthcheck will
 * roll back a working deployment, and a compose file using
 * `depends_on: condition: service_healthy` will refuse to start anything that
 * depends on this service. Both failure modes look like "the app is broken"
 * when the app is fine.
 *
 * A healthcheck answers exactly one question: is this process alive and able to
 * serve? It must not require credentials, and it must not query the database —
 * a database hiccup should not be reported as a dead process.
 */
@Controller('api/health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'oneteam-api',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: Date.now(),
    };
  }
}
