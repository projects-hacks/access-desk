import {
  AlertTriangle, Bell, CircleHelp, Coins, FileCheck2, Flag, Gauge, Link2, Lock, OctagonAlert, RotateCcw, Scale, ShieldAlert, Undo2,
  Unlock, Wallet, type LucideIcon,
} from 'lucide-react';

/** One icon per kind of work, so a queue can be scanned at a glance. */
const ICONS: Record<string, LucideIcon> = {
  PAYMENT_MATCH: Link2,
  UNIDENTIFIED_CASH: CircleHelp,
  REFUND: Undo2,
  PAYMENT_REVERSAL: RotateCcw,
  CUSTODY_DEBIT: Wallet,
  RESTRICTION: Lock,
  RESTORE: Unlock,
  REMINDER: Bell,
  CREDIT_REVIEW: Gauge,
  POLICY_DRAFT: FileCheck2,
  EXPLOIT_FLAG: Flag,
  BOOKS_BREAK: Scale,
  SYSTEM_EXCEPTION: AlertTriangle,
  UNEXPLAINED_OUTFLOW: OctagonAlert,
  UNAPPLIED_CASH: Coins,
  PERMISSION_CHANGE: ShieldAlert,
};

export function KindIcon({ kind, size = 13 }: { kind: string; size?: number }) {
  const Icon = ICONS[kind];
  return Icon ? <Icon size={size} aria-hidden className="kind-icon" /> : null;
}
