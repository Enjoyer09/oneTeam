/**
 * oneTeam Retail Execution Platform — Task Lifecycle State Machine
 * Modeled after Salesforce Consumer Goods Cloud & GoSpotCheck.
 */
export declare enum TaskState {
    DRAFT = "DRAFT",
    PUBLISHED = "PUBLISHED",
    DELIVERED = "DELIVERED",
    ACKNOWLEDGED = "ACKNOWLEDGED",
    IN_PROGRESS = "IN_PROGRESS",
    SUBMITTED = "SUBMITTED",
    APPROVED = "APPROVED",
    REJECTED = "REJECTED"
}
/**
 * Strict legal transition graph.
 * Any state transition not listed here MUST be rejected with HTTP 400.
 */
export declare const ALLOWED_STATE_TRANSITIONS: Record<TaskState, readonly TaskState[]>;
export declare class InvalidStateTransitionError extends Error {
    readonly currentState: TaskState;
    readonly targetState: TaskState;
    readonly statusCode = 400;
    constructor(currentState: TaskState, targetState: TaskState, details?: string);
}
/**
 * Validates whether transition from currentState to targetState is permitted.
 */
export declare function isValidTransition(current: TaskState, target: TaskState): boolean;
/**
 * Asserts transition is valid or throws InvalidStateTransitionError with 400 Bad Request semantics.
 */
export declare function assertValidTransition(current: TaskState, target: TaskState, details?: string): void;
//# sourceMappingURL=state-machine.d.ts.map