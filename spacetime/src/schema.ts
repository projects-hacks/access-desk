import { schema } from 'spacetimedb/server';
import { auditEvent } from './tables/audit';
import { assetPrice, custodyHolding, hold, loan, owedToClient, position } from './tables/assets';
import { accessLever, capability, client, contract, contractClause, payerIdentity } from './tables/clients';
import { creditProfile, exploitFlag, policy, precedent } from './tables/learning';
import { cashMovement, clientCredit, dispute, invoice, ledgerEntry, paymentApplication } from './tables/money';
import { rawRecord, syncSource } from './tables/sync';
import {
  accessRequest, agentRun, deadline, decision, gatewayCommand, investigationStep, notice, rmNote, workItem,
} from './tables/work';
import { actor, clock, platform } from './tables/world';

export const spacetimedb = schema({
  platform, clock, actor,
  syncSource, rawRecord,
  client, payerIdentity, contract, contractClause, capability, accessLever,
  invoice, dispute, cashMovement, paymentApplication, clientCredit, ledgerEntry,
  custodyHolding, assetPrice, hold, owedToClient, position, loan,
  workItem, decision, investigationStep, rmNote, notice, gatewayCommand, accessRequest, deadline, agentRun,
  creditProfile, policy, precedent, exploitFlag,
  auditEvent,
});
