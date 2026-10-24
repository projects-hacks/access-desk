import { spacetimedb } from './schema';

export default spacetimedb;

// Every exported reducer is callable by clients under its export name (snake_case on the wire).
export * from './reducers/world';
export * from './reducers/sync';
export * from './reducers/work';
export { proposeCustodyDebit, proposeRestriction, proposeRestore, proposeNotice, requestCustodyWithdrawal, setDeadline } from './reducers/actions';
export { placeHold } from './reducers/payments';
export * from './reducers/gateway';
export * from './reducers/books';
export { upsertPolicy } from './reducers/policies';
export { addRmNote, recordInvestigation } from './reducers/notes';
export { recordAgentRun } from './reducers/runs';
