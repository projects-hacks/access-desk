import type { IsoDate } from './types';

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** '2025-12' -> '2026-01' */
export function monthAfter(period: string): string {
  const d = new Date(`${period}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
