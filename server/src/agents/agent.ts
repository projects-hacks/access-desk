/** Agents read golden state and propose work items. They never write to systems of record. */
export interface Agent {
  readonly name: string;
  run(): Promise<void>;
}
