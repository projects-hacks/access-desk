/** A system of record we read from, change-only, with a cursor. */
export interface SyncSource<Raw = unknown> {
  readonly name: string;
  fetchChanges(cursor: string | undefined): Promise<{ rows: Raw[]; cursor: string | undefined }>;
}
