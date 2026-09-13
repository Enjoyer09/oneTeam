/**
 * oneTeam Retail Execution Platform — Task Lifecycle State Machine
 * Modeled after Salesforce Consumer Goods Cloud & GoSpotCheck.
 */

export enum TaskState {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  DELIVERED = 'DELIVERED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  IN_PROGRESS = 'IN_PROGRESS',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * Strict legal transition graph.
 * Any state transition not listed here MUST be rejected with HTTP 400.
 */
export const ALLOWED_STATE_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  [TaskState.DRAFT]: [TaskState.PUBLISHED],
  [TaskState.PUBLISHED]: [TaskState.DELIVERED],
  [TaskState.DELIVERED]: [TaskState.ACKNOWLEDGED],
  [TaskState.ACKNOWLEDGED]: [TaskState.IN_PROGRESS],
  [TaskState.IN_PROGRESS]: [TaskState.SUBMITTED],
  [TaskState.SUBMITTED]: [TaskState.APPROVED, TaskState.REJECTED],
  [TaskState.APPROVED]: [], // Terminal state
  [TaskState.REJECTED]: [TaskState.IN_PROGRESS], // Re-audit retry allowed by supervisor
};

export class InvalidStateTransitionError extends Error {
  public readonly statusCode = 400;
  constructor(
    public readonly currentState: TaskState,
    public readonly targetState: TaskState,
    details?: string
  ) {
    const allowed = ALLOWED_STATE_TRANSITIONS[currentState]?.join(', ') || 'NONE (Terminal State)';
    super(
      `Qadağan olunmuş status keçidi: '${currentState}' -> '${targetState}'. İcazə verilən növbəti statuslar: [${allowed}]. ${
        details ? `Əlavə məlumat: ${details}` : ''
      }`
    );
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Validates whether transition from currentState to targetState is permitted.
 */
export function isValidTransition(current: TaskState, target: TaskState): boolean {
  const allowed = ALLOWED_STATE_TRANSITIONS[current];
  if (!allowed) return false;
  return allowed.includes(target);
}

/**
 * Asserts transition is valid or throws InvalidStateTransitionError with 400 Bad Request semantics.
 */
export function assertValidTransition(current: TaskState, target: TaskState, details?: string): void {
  if (!isValidTransition(current, target)) {
    throw new InvalidStateTransitionError(current, target, details);
  }
}
