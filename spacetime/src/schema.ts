import { schema } from 'spacetimedb/server';
import { agentTask, episode, episodeStep } from './tables/agents';
import { auditEvent } from './tables/audit';
import { tradeOrder } from './tables/orders';
import { tieOutBreak, tieOutRun } from './tables/books';
import { assetPrice, custodyHolding, hold, loan, owedToClient, position } from './tables/assets';
import { accessLever, capability, client, contract, contractClause, payerIdentity, permission } from './tables/clients';
import { creditProfile, exploitFlag, metricSnapshot, policy, precedent } from './tables/learning';
import { bankAccount, cashMovement, clientCredit, dispute, invoice, ledgerEntry, paymentApplication } from './tables/money';
import { rawRecord, syncSource } from './tables/sync';
import {
  accessRequest, agentRun, deadline, decision, gatewayCommand, investigationStep, notice, rmNote, workItem,
} from './tables/work';
import { actor, clock, clockTick, platform } from './tables/world';

export const spacetimedb = schema({
  platform, clock, clockTick, actor,
  syncSource, rawRecord,
  client, payerIdentity, contract, contractClause, capability, accessLever, permission,
  invoice, dispute, cashMovement, paymentApplication, clientCredit, ledgerEntry, bankAccount,
  custodyHolding, assetPrice, hold, owedToClient, position, loan,
  workItem, decision, investigationStep, rmNote, notice, gatewayCommand, accessRequest, deadline, agentRun,
  creditProfile, policy, precedent, exploitFlag, metricSnapshot,
  tieOutRun, tieOutBreak,
  agentTask, episode, episodeStep, tradeOrder,
  auditEvent,
});
