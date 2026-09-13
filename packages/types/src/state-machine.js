"use strict";
/**
 * oneTeam Retail Execution Platform — Task Lifecycle State Machine
 * Modeled after Salesforce Consumer Goods Cloud & GoSpotCheck.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidStateTransitionError = exports.ALLOWED_STATE_TRANSITIONS = exports.TaskState = void 0;
exports.isValidTransition = isValidTransition;
exports.assertValidTransition = assertValidTransition;
var TaskState;
(function (TaskState) {
    TaskState["DRAFT"] = "DRAFT";
    TaskState["PUBLISHED"] = "PUBLISHED";
    TaskState["DELIVERED"] = "DELIVERED";
    TaskState["ACKNOWLEDGED"] = "ACKNOWLEDGED";
    TaskState["IN_PROGRESS"] = "IN_PROGRESS";
    TaskState["SUBMITTED"] = "SUBMITTED";
    TaskState["APPROVED"] = "APPROVED";
    TaskState["REJECTED"] = "REJECTED";
})(TaskState || (exports.TaskState = TaskState = {}));
/**
 * Strict legal transition graph.
 * Any state transition not listed here MUST be rejected with HTTP 400.
 */
exports.ALLOWED_STATE_TRANSITIONS = {
    [TaskState.DRAFT]: [TaskState.PUBLISHED],
    [TaskState.PUBLISHED]: [TaskState.DELIVERED],
    [TaskState.DELIVERED]: [TaskState.ACKNOWLEDGED],
    [TaskState.ACKNOWLEDGED]: [TaskState.IN_PROGRESS],
    [TaskState.IN_PROGRESS]: [TaskState.SUBMITTED],
    [TaskState.SUBMITTED]: [TaskState.APPROVED, TaskState.REJECTED],
    [TaskState.APPROVED]: [], // Terminal state
    [TaskState.REJECTED]: [TaskState.IN_PROGRESS], // Re-audit retry allowed by supervisor
};
class InvalidStateTransitionError extends Error {
    currentState;
    targetState;
    statusCode = 400;
    constructor(currentState, targetState, details) {
        const allowed = exports.ALLOWED_STATE_TRANSITIONS[currentState]?.join(', ') || 'NONE (Terminal State)';
        super(`Qadağan olunmuş status keçidi: '${currentState}' -> '${targetState}'. İcazə verilən növbəti statuslar: [${allowed}]. ${details ? `Əlavə məlumat: ${details}` : ''}`);
        this.currentState = currentState;
        this.targetState = targetState;
        this.name = 'InvalidStateTransitionError';
    }
}
exports.InvalidStateTransitionError = InvalidStateTransitionError;
/**
 * Validates whether transition from currentState to targetState is permitted.
 */
function isValidTransition(current, target) {
    const allowed = exports.ALLOWED_STATE_TRANSITIONS[current];
    if (!allowed)
        return false;
    return allowed.includes(target);
}
/**
 * Asserts transition is valid or throws InvalidStateTransitionError with 400 Bad Request semantics.
 */
function assertValidTransition(current, target, details) {
    if (!isValidTransition(current, target)) {
        throw new InvalidStateTransitionError(current, target, details);
    }
}
//# sourceMappingURL=state-machine.js.map