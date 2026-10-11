/**
 * The dashboard's load phase: one reducer instead of three booleans that can
 * disagree with each other.
 *
 * `ready` means "the numbers on screen were fetched and the fetch succeeded" —
 * so a failed background refresh (window focus) must leave `ready`, or the
 * panel keeps showing minutes-old KPIs as if they were current.
 */

export type LoadPhase = 'loading' | 'ready' | 'error';

export type LoadAction = { type: 'loaded' } | { type: 'failed' } | { type: 'retry' };

export function loadPhaseReducer(phase: LoadPhase, action: LoadAction): LoadPhase {
  switch (action.type) {
    case 'loaded':
      return 'ready';
    case 'failed':
      return 'error';
    case 'retry':
      return 'loading';
    default:
      return phase;
  }
}
