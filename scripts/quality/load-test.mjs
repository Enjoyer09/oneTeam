#!/usr/bin/env node
/** Bounded, read-only load test. Only loopback targets are accepted. */
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const base = new URL(process.env.QA_API_URL || 'http://127.0.0.1:3917');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  throw new Error('Load tests require an isolated loopback API; remote targets are refused.');
}
const token = process.env.QA_API_TOKEN || 'oneteam-user:usr-admin-001';
const endpoints = [
  '/api/portal/bootstrap',
  '/api/portal/stores',
  '/api/portal/products',
  '/api/portal/tasks',
];
const stages = [
  ['baseline', 1, 10],
  ['load', 10, 15],
  ['stress-25', 25, 15],
  ['stress-50', 50, 15],
  ['spike', 100, 10],
  ['recovery', 1, 10],
  ['short-soak', 10, 60],
];
const health = await fetch(new URL('/api/health', base), {
  redirect: 'error',
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json());
if (health.persistence !== 'postgres' || health.status !== 'ok') {
  throw new Error('An isolated healthy PostgreSQL-backed API is required.');
}
const results = [];
for (const [name, concurrency, seconds] of stages) {
  const started = performance.now();
  const end = started + seconds * 1000;
  const latencies = [];
  const statuses = {};
  let errors = 0;
  let sequence = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < end) {
        const path = endpoints[sequence++ % endpoints.length];
        const before = performance.now();
        let status = 'network-error';
        try {
          const response = await fetch(new URL(path, base), {
            headers: { Authorization: `Bearer ${token}` },
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
          });
          status = String(response.status);
          const body = await response.json();
          if (!response.ok || body.success !== true || body.data === undefined) errors++;
        } catch {
          errors++;
        }
        statuses[status] = (statuses[status] || 0) + 1;
        latencies.push(performance.now() - before);
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const percentile = (p) =>
    Number(latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)].toFixed(2));
  const result = {
    name,
    concurrency,
    durationSeconds: Number(elapsed.toFixed(2)),
    requests: latencies.length,
    errors,
    statuses,
    requestsPerSecond: Number((latencies.length / elapsed).toFixed(1)),
    p50ms: percentile(0.5),
    p95ms: percentile(0.95),
    p99ms: percentile(0.99),
    maxMs: percentile(1),
  };
  results.push(result);
  console.log(JSON.stringify(result));
  if (errors > latencies.length * 0.05) {
    console.error('Stopped: more than 5% errors. Diagnose before increasing load.');
    break;
  }
}
const finalHealth = await fetch(new URL('/api/health', base), {
  redirect: 'error',
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json());
const passed =
  results.length === stages.length &&
  results.every((r) => r.errors === 0 && r.p95ms < 1000) &&
  finalHealth.status === 'ok' &&
  finalHealth.persistence === 'postgres';
const report = {
  target: base.origin,
  endpoints,
  thresholds: { errors: 0, p95ms: 1000 },
  workload:
    'Closed-loop reads on the seeded local dataset; not production capacity or sustained soak evidence.',
  results,
  passed,
};
if (process.env.QA_REPORT)
  await writeFile(process.env.QA_REPORT, JSON.stringify(report, null, 2) + '\n');
process.exitCode = passed ? 0 : 1;
