import { z } from 'zod';
import { build, changed } from '../exploit/scan';
import { writeScan } from '../exploit/write';
import type { Verdict } from '../exploit/model';
import type { Facts } from './facts';
import type { Actor, Gate } from './gate';
import { json, plain } from './text';
import type { ToolDef } from './toolset';

const reason = z.string().min(5).max(600).describe('Why, in one to three short plain sentences. No semicolons, no dashes, no pattern codes.');

/**
 * Rowan's tools: the findings the detectors and consistency checks produced, every detector's
 * measurement, and one action, flag_pattern. Flagging writes the same flag row and (for an alert)
 * the same EXPLOIT_FLAG work item as the rules do. It never restricts, holds or debits.
 */
export function rowanTools(f: Facts, actor: Actor, gate: Gate): ToolDef[] {
  const x = f.exploit;
  if (!x) return [];
  const flagged = new Set<string>();
  const stored = (id: string) => x.stored.get(id);

  return [
    {
      name: 'findings', readOnly: true, input: {},
      description: 'Everything the detectors found on this client: payment-term patterns, discrepancies in its rows and sudden changes. Each has an id (use it with flag_pattern), severity, what was measured, the evidence ids, the proposed fix, what the rules would label it and any flag already on file.',
      run: async () => json({
        today: f.today,
        findings: x.findings.map((g) => ({
          id: g.id, check: g.check.replace(/_/g, ' '), kind: g.source, severity: g.severity, measured: g.measured, months: g.months || undefined,
          evidence: g.evidence.slice(0, 8).concat(g.evidence.length > 8 ? [`and ${g.evidence.length - 8} more`] : []), proposedFix: g.proposedFix,
          rulesWouldLabel: x.verdicts.get(g.id)?.label, flagOnFile: stored(g.id)?.status,
        })),
      }),
    },
    {
      name: 'pattern_checks', readOnly: true, input: {},
      description: 'Every payment-term detector with what it measured on this client and whether it fired, including the ones that did not fire (so you can see why a client was cleared).',
      run: async () => json({ checks: x.checks.map((c) => ({ pattern: c.pattern.replace(/_/g, ' '), fired: c.fired, measured: c.measured, score: c.score, months: c.months || undefined })) }),
    },
    {
      name: 'flag_pattern', readOnly: false,
      input: {
        finding_id: z.string().describe('The id of a finding from the findings tool'),
        label: z.enum(['alert', 'watch']).describe('alert: a controller should act now. watch: keep an eye on it, no work item.'),
        reason,
      },
      description: 'ACTION. Flag one finding for a controller. alert writes the flag and raises a work item. watch writes the flag only. Call it once per finding worth flagging. Findings you skip are treated as noise. It never restricts anything.',
      run: async (a) => {
        const finding = x.findings.find((g) => g.id === a.finding_id);
        if (!finding) return gate.refuse('flag_pattern', { finding_id: a.finding_id }, `no finding with that id. Ids: ${x.findings.map((g) => g.id).join(', ') || 'none'}`);
        if (flagged.has(finding.id)) return 'already flagged this finding this task.';
        const verdict: Verdict = { findingId: finding.id, label: a.label, reason: plain(a.reason), decidedBy: 'claude' };
        const s = build(x.scanInput, [finding], new Map([[finding.id, verdict]]));
        const row = s.flags[0]!;
        const old = stored(finding.id);
        if (old?.status === 'cleared') return 'a controller cleared this flag, so it is left alone.';
        // An agent adds flags or raises them; it never lowers one already on file.
        if (old?.status === 'flagged' && row.status === 'watch') return 'already flagged; an agent never lowers a flag on file, so it is left as it is.';
        if (!changed(row, old) && !s.proposals.length) {
          const text = `already on file as ${old?.status}, nothing to change.`;
          gate.outcomes.push({ tool: 'flag_pattern', args: { finding_id: finding.id, label: a.label }, text, refused: false });
          flagged.add(finding.id);
          return text;
        }
        const done = `done: flagged as ${row.status}${s.proposals.length ? ' and raised an alert for a controller' : ''}.`;
        const text = await gate.act('flag_pattern', { finding_id: finding.id, label: a.label }, done, async () => {
          const r = await writeScan(actor, f.view.client.name, s, new Map(old ? [[finding.id, old]] : []));
          return r.refusals[0];
        });
        if (!text.startsWith('refused')) flagged.add(finding.id);
        return text;
      },
    },
  ];
}
