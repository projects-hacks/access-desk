import { useMemo, useRef } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import type { AgentTask, Episode, EpisodeStep } from '../module_bindings/types';
import { ago, useNow } from './bank';
import { waitingReason } from './autonomy';
import { bulletLines, parseJson, plainText } from './format';

/** The four Factory Droids, in roster order: who they are to the people watching, and what each is for. */
export const AGENTS = [
  { key: 'learning', name: 'Iris', role: 'Learning', purpose: "Reads each client's payment history and keeps their credit profile current." },
  { key: 'scoring', name: 'Quinn', role: 'Scoring & tiers', purpose: 'Turns the credit profile into a tier and proposes tier changes.' },
  { key: 'exploit', name: 'Rowan', role: 'ExploitWatch', purpose: 'Watches for clients gaming the payment terms.' },
  { key: 'access', name: 'Sage', role: 'Access controller', purpose: 'Holds, restricts and restores access, only as far as the contract allows.' },
] as const;

const AGENT_KEYS = new Set<string>(AGENTS.map((a) => a.key));
export const isAgent = (actor: string) => AGENT_KEYS.has(actor);

const LEARNING = new Set(['LEARNED', 'POLICY_OUTCOME', 'POLICY_ACTIVATED']);

/** An episode counts as running while one of its tasks is open or a step landed this recently. */
const BUSY_MS = 3_000;
/** A finished episode stays in the "Now" card this long so the outcome can be read. */
const SETTLE_MS = 10_000;
/** A queued task this young is about to be picked up; an older one is waiting on an agent that isn't running. */
const QUEUED_FRESH_MS = 60_000;
/** Open tasks older than this are stuck, not working. */
const STALE_TASK_MS = 10 * 60_000;
/** The "Earlier" list shows this many episodes. */
export const EARLIER_LIMIT = 30;

export type EpisodeView = {
  episode: Episode;
  clientName: string;
  steps: EpisodeStep[];
  running: boolean;
  /** Agents working on this episode right now (a Droid session can take a minute or two). */
  working: string[];
  /** When it last moved, and the business day that was: a person deciding an old request brings it back to today. */
  lastAt: { microsSinceUnixEpoch: bigint };
  day: string;
  /** Last step minus first, in milliseconds. */
  totalMs: number;
};

export type AgentStatus = { key: string; name: string; role: string; purpose: string; working: boolean; status: string };

export type Need = { episodeId: bigint; clientId: string; clientName: string; title: string; detail: string; workItemId?: bigint };

const ms = (ts: { microsSinceUnixEpoch: bigint }) => Number(ts.microsSinceUnixEpoch / 1000n);

/** "14:03" or "14:03:21", in the viewer's time zone. */
export function clock(ts: { microsSinceUnixEpoch: bigint }, seconds = false): string {
  return new Date(ms(ts)).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
  });
}

/** Time since the episode began: 0.14s, 2.3s, 1m 04s. */
export function offset(deltaMs: number): string {
  const d = Math.max(0, deltaMs);
  if (d < 1000) return `${(d / 1000).toFixed(2)}s`;
  if (d < 60_000) return `${(d / 1000).toFixed(1)}s`;
  const s = Math.round(d / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Display wording for rows the module (or an agent) wrote: see `plainText`. */
export const tidy = plainText;

const FILLER = new Set(['the', 'a', 'an', 'of', 'to', 'from', 'for', 'on', 'in', 'and', 'moved', 'changed', 'now', 'is', 'was']);
const words = (s: string, client: string) =>
  new Set(s.toLowerCase().replace(client.toLowerCase(), ' ').split(/[^a-z0-9$.,]+/).filter((w) => w && !FILLER.has(w)));

/** The same news in other words ("Kestrel: tier 3 → 4" and "Moved from tier 3 to tier 4."), so it is shown once. */
export function sameNews(a: string, b: string, client = ''): boolean {
  if (!a || !b) return false;
  const [x, y] = [words(a, client), words(b, client)];
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  if (!small.size) return true;
  return [...small].filter((w) => big.has(w)).length / small.size >= 0.8;
}

/** "Cobalt Ridge Treasury: earlier reminders…" → "Earlier reminders…" where the client is already shown. */
export function withoutClient(text: string, client: string): string {
  const rest = client && text.startsWith(`${client}: `) ? text.slice(client.length + 2) : text;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** A guardrail chip's wording: bare policy or contract references become plain statements. */
function checkLabel(c: { ok: boolean; label: string }, names: Map<string, string>): string {
  const label = tidy(c.label, names);
  if (label === 'Policy') return c.ok ? 'Within policy' : 'Against policy';
  if (label === 'Contract') return c.ok ? 'Within the contract' : 'Against the contract';
  // A client's own policy comes through as just the client's name.
  if ([...names.values()].includes(label)) return c.ok ? "Within this client's own policy" : "Against this client's own policy";
  return label;
}

/** Steps and episodes that appeared after the first load, with when they arrived (for live animation). */
function useArrivals(ids: bigint[], ready: boolean): Map<bigint, number> {
  const known = useRef<Set<bigint> | undefined>(undefined);
  const arrived = useRef(new Map<bigint, number>());
  if (ready) {
    if (!known.current) known.current = new Set(ids);
    else {
      for (const id of ids) {
        if (known.current.has(id)) continue;
        known.current.add(id);
        arrived.current.set(id, Date.now());
      }
    }
  }
  return arrived.current;
}

export type AgentsView = {
  ready: boolean;
  roster: AgentStatus[];
  needs: Need[];
  /** What an agent looked at before proposing, by request: the chain under its step. */
  investigations: Map<bigint, { tool: string; summary: string }[]>;
  /** The newest episode that is running, or finished moments ago. */
  now?: EpisodeView;
  /** The platform's business day ('YYYY-MM-DD'). */
  today: string;
  /** Today's episodes besides the live one, newest first. */
  earlier: EpisodeView[];
  /** Episodes today, including those beyond the cap. */
  total: number;
  /** While today has little to show: the last few episodes of the day before, and that day. */
  before: EpisodeView[];
  beforeDay: string;
  /** Lessons recorded today: rejections learned from, client policies checked or put in force. */
  learned: number;
  working: boolean;
  /** Did this step arrive by push in the last few seconds (as opposed to being there on load)? */
  isFresh: (step: EpisodeStep) => boolean;
};

/** Everything the agents panel shows, from the agent_task, episode and episode_step tables. */
export function useAgents(): AgentsView {
  const [tasks, tasksReady] = useTable(tables.agentTask);
  const [episodes, episodesReady] = useTable(tables.episode);
  const [steps, stepsReady] = useTable(tables.episodeStep);
  const [clients, clientsReady] = useTable(tables.client);
  const [clockRows] = useTable(tables.clock);
  const [audit] = useTable(tables.auditEvent);
  const [items] = useTable(tables.workItem);
  const today = clockRows[0]?.simDate ?? '';
  const ready = tasksReady && episodesReady && stepsReady && clientsReady;
  const now = useNow(1000);
  const arrivals = useArrivals(
    steps.map((s) => s.id),
    ready,
  );

  return useMemo(() => {
    const names = new Map(clients.map((c) => [c.id, c.name]));
    const nameOf = (id: string) => names.get(id) ?? (id === 'books' ? 'The books' : id);
    const open = (t: AgentTask) =>
      (t.status === 'queued' || t.status === 'running') && now - ms(t.updatedAt) < STALE_TASK_MS;

    const stepsBy = new Map<bigint, EpisodeStep[]>();
    for (const raw of steps) {
      const s: EpisodeStep = {
        ...raw,
        text: tidy(raw.text, names),
        reason: raw.reason ? tidy(raw.reason, names) : '',
        instead: raw.instead ? tidy(raw.instead, names) : '',
        checks: raw.checks.filter((c) => c.label.toLowerCase() !== 'none').map((c) => ({ ...c, label: checkLabel(c, names) })),
      };
      stepsBy.set(s.episodeId, [...(stepsBy.get(s.episodeId) ?? []), s]);
    }
    for (const list of stepsBy.values()) list.sort((a, b) => ms(a.at) - ms(b.at) || Number(a.id - b.id));

    const busy = new Set(
      tasks
        .filter((t) => t.episodeId > 0n && open(t) && (t.status === 'running' || now - ms(t.createdAt) < QUEUED_FRESH_MS))
        .map((t) => t.episodeId),
    );
    const lastArrival = (list: EpisodeStep[]) => Math.max(0, ...list.map((s) => arrivals.get(s.id) ?? 0));

    // The panel is about the agents: an episode shows once an agent has a step in it, or while an
    // agent is working on it. Everything else (a withdrawal the platform paid out, say) is in the Audit log.
    // A client's own policy sending its reminder on the daily clock counts too: an agent put that policy in force.
    const withAgent = (id: bigint) => busy.has(id) || (stepsBy.get(id) ?? []).some((s) => isAgent(s.actor) || (s.actor === 'scheduler' && /^Reminder to /.test(s.text)));
    // The business day a moment falls in: the last day whose first audit row came before it.
    const dayStart = new Map<string, number>();
    for (const e of audit) {
      const t = ms(e.at);
      const s = dayStart.get(e.simDate);
      if (s === undefined || t < s) dayStart.set(e.simDate, t);
    }
    const days = [...dayStart].sort((a, b) => a[1] - b[1]);
    const dayAt = (t: number) => days.filter(([, s]) => s <= t).at(-1)?.[0];

    const views = [...episodes]
      .filter((e) => withAgent(e.id))
      .map((raw): EpisodeView & { settling: boolean } => {
        // An outcome written as points reads as its first point on the one-line row.
        const outcome = raw.outcome ? (bulletLines(raw.outcome)?.[0] ?? raw.outcome) : '';
        const episode = { ...raw, trigger: tidy(raw.trigger, names), outcome: outcome ? tidy(outcome, names) : '' };
        const list = stepsBy.get(raw.id) ?? [];
        const landed = lastArrival(list);
        const running = busy.has(episode.id) || now - landed < BUSY_MS;
        return {
          episode,
          clientName: nameOf(episode.clientId),
          steps: list,
          running,
          working: [...new Set(tasks.filter((t) => t.episodeId === raw.id && t.status === 'running' && open(t)).map((t) => t.agent))],
          settling: running || now - landed < SETTLE_MS,
          totalMs: list.length > 1 ? ms(list[list.length - 1]!.at) - ms(list[0]!.at) : 0,
          lastAt: list.at(-1)?.at ?? raw.startedAt,
          day: (list.length ? dayAt(ms(list.at(-1)!.at)) : undefined) ?? raw.simDate,
        };
      })
      .sort((a, b) => ms(b.lastAt) - ms(a.lastAt) || (a.episode.id < b.episode.id ? 1 : -1));
    const live = views.find((v) => v.settling);
    // History lives in the Audit log; the panel is about the business day.
    const earlier = views.filter((v) => v !== live && v.day === today);
    const older = views.filter((v) => v !== live && v.day !== today);
    const beforeDay = older.find((v) => v.day)?.day ?? '';
    const before = earlier.length < 3 ? older.filter((v) => v.day === beforeDay).slice(0, 5) : [];

    const roster = AGENTS.map(({ key, name, role, purpose }): AgentStatus => {
      const mine = tasks.filter((t) => t.agent === key);
      const running = mine.filter((t) => t.status === 'running' && open(t));
      const queued = mine.filter((t) => t.status === 'queued' && open(t));
      const last = mine.filter((t) => t.status === 'done').sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt))[0];
      const status = running.length
        ? `working · ${nameOf(running[0]!.clientId)}${running.length > 1 ? ` +${running.length - 1}` : ''}`
        : queued.length
          ? `${queued.length} in line`
          : last
            ? `idle · last active ${ago(now - ms(last.updatedAt))}`
            : 'idle';
      return { key, name, role, purpose, working: running.length > 0, status };
    });

    // The same requests Approvals lists as waiting, each with the episode that raised it.
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const episodeOf = new Map(steps.filter((s) => s.workItemId > 0n).map((s) => [s.workItemId, s.episodeId]));
    const needs = items
      .filter((w) => !w.autoApplied && waitingReason(w, clientById.get(w.clientId)))
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .map((w): Need => ({
        episodeId: episodeOf.get(w.id) ?? 0n,
        clientId: w.clientId,
        workItemId: w.id,
        clientName: nameOf(w.clientId),
        title: tidy(w.title, names),
        detail: waitingReason(w, clientById.get(w.clientId)) ?? '',
      }));

    return {
      ready,
      roster,
      needs,
      investigations: new Map(items.flatMap((w) => {
        const inv = parseJson<{ investigation?: { tool: string; summary: string }[] }>(w.proposalJson, {}).investigation;
        return inv?.length ? [[w.id, inv.map((s) => ({ tool: s.tool, summary: tidy(s.summary, names) }))] as const] : [];
      })),
      now: live,
      today,
      earlier: earlier.slice(0, EARLIER_LIMIT),
      total: earlier.length,
      before,
      beforeDay,
      learned: audit.filter((e) => e.simDate === today && e.allowed && LEARNING.has(e.action)).length,
      working: roster.some((r) => r.working) || !!live?.running,
      isFresh: (step: EpisodeStep) => now - (arrivals.get(step.id) ?? 0) < SETTLE_MS,
    };
  }, [tasks, episodes, steps, clients, audit, items, today, ready, now, arrivals]);
}
