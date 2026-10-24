import { spacetimedb } from './schema';

export default spacetimedb;

// Every exported reducer is callable by clients under its export name.
export * from './reducers/actors';
export * from './reducers/ingest';
export * from './reducers/work-items';
