/** Neither Droid nor Claude could answer; the caller falls back to its rules. */
export class DecisionUnavailable extends Error {}

/** The model answered twice, and the caller's validation rejected both answers. */
export class AnswerRejected extends DecisionUnavailable {}
