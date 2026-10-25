import { spacetimedb } from './schema';

export default spacetimedb;

// Every exported reducer is callable by clients under its export name (snake_case on the wire).
export * from './reducers/world';
export * from './reducers/sync';
export * from './reducers/work';
export { proposeCustodyDebit, proposeRestriction, proposeRestrictionWithBoundaries, proposeRestore, proposeNotice, requestCustodyWithdrawal, setDeadline } from './reducers/actions';
export { placeHold } from './reducers/payments';
export * from './reducers/gateway';
export * from './reducers/books';
export { upsertPolicy } from './reducers/policies';
export { addRmNote, recordInvestigation } from './reducers/notes';
export { recordAgentRun, recordWait } from './reducers/runs';
export { proposePaymentMatch } from './reducers/matches';
export { recordPolicyOutcome, upsertCreditProfile, upsertExploitFlag } from './reducers/credit';
export { proposePermissionChange, proposeTierChange } from './reducers/manual';
export { proposeGuidelineChange, recordConsolePrecedent, setStrategic } from './reducers/guidelines';
export {
  bindPortal, myAccessRequests, myOrders, myBankAccounts, myClient, myHoldings, myHolds, myInvoices, myLevers, myNotices, myPermissions,
} from './reducers/portal';
export { claimAgentTask, completeAgentTask, failAgentTask, heartbeatAgentTask, queueSweep, recordAgentStep, recordGuardrail } from './reducers/agents';
export { placeOrder } from './reducers/orders';
