import { useMemo, useRef } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import type { AgentTask, Episode, EpisodeStep } from '../module_bindings/types';
import { useNow } from './bank';
import { plainText } from './format';

/** The four Factory Droids, in roster order: who they are to the people watching, and what each is for. */
export const AGENTS = [
  { key: 'learning', name: 'Iris', role: 'Learning', purpose: "Reads each client's payment history and keeps their credit profile current." },
  { key: 'scoring', name: 'Quinn', role: 'Scoring & tiers', purpose: 'Turns the credit profile into a tier and proposes tier changes.' },
  { key: 'exploit', name: 'Rowan', role: 'ExploitWatch', purpose: 'Watches for clients gaming the payment terms.' },
  { key: 'access', name: 'Sage', role: 'Access controller', purpose: 'Holds, restricts and restores access, only as far as the contract allows.' },
] as const;

const AGENT_KEYS = new Set<string>(AGENTS.map((a) => a.key));
export const isAgent = (actor: string) => AGENT_KEYS.has(actor);

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

/** A guardrail chip's wording: bare policy or contract references become plain statements. */
function checkLabel(c: { ok: boolean; label: string }, names: Map<string, string>): string {
  const label = tidy(c.label, names);
  if (label === 'Policy') return c.ok ? 'Within policy' : 'Against policy';
  if (label === 'Contract') return c.ok ? 'Within the contract' : 'Against the contract';
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
  /** The newest episode that is running, or finished moments ago. */
  now?: EpisodeView;
  earlier: EpisodeView[];
  /** Episodes that exist, including those beyond the Earlier cap. */
  total: number;
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
  const ready = tasksReady && episodesReady && stepsReady && clientsReady;
  const now = useNow(1000);
  const arrivals = useArrivals(
    steps.map((s) => s.id),
    ready,
  );

  return useMemo(() => {
    const names = new Map(clients.map((c) => [c.id, c.name]));
    const nameOf = (id: string) => names.get(id) ?? id;
    const open = (t: AgentTask) =>
      (t.status === 'queued' || t.status === 'running') && now - ms(t.updatedAt) < STALE_TASK_MS;

    const stepsBy = new Map<bigint, EpisodeStep[]>();
    for (const raw of steps) {
      const s: EpisodeStep = {
        ...raw,
        text: tidy(raw.text, names),
        reason: raw.reason ? tidy(raw.reason, names) : '',
        instead: raw.instead ? tidy(raw.instead, names) : '',
        checks: raw.checks.map((c) => ({ ...c, label: checkLabel(c, names) })),
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

    const views = [...episodes]
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .map((raw): EpisodeView & { settling: boolean } => {
        const episode = { ...raw, trigger: tidy(raw.trigger, names), outcome: raw.outcome ? tidy(raw.outcome, names) : '' };
        const list = stepsBy.get(raw.id) ?? [];
        const landed = lastArrival(list);
        const running = busy.has(episode.id) || now - landed < BUSY_MS;
        return {
          episode,
          clientName: nameOf(episode.clientId),
          steps: list,
          running,
          settling: running || now - landed < SETTLE_MS,
          totalMs: list.length > 1 ? ms(list[list.length - 1]!.at) - ms(list[0]!.at) : 0,
        };
      });
    const live = views.find((v) => v.settling);
    const earlier = views.filter((v) => v !== live);

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
            ? `idle · last ${clock(last.updatedAt)}`
            : 'idle';
      return { key, name, role, purpose, working: running.length > 0, status };
    });

    const needs = views
      .filter((v) => v.episode.kind === 'waiting')
      .map((v): Need => {
        const withItem = v.steps.find((s) => s.workItemId > 0n);
        const proposal = withItem?.text ?? v.episode.outcome ?? v.episode.trigger;
        return {
          episodeId: v.episode.id,
          clientId: v.episode.clientId,
          workItemId: withItem?.workItemId,
          clientName: v.clientName,
          title: proposal,
          detail: v.episode.outcome && v.episode.outcome !== proposal ? v.episode.outcome : '',
        };
      });

    return {
      ready,
      roster,
      needs,
      now: live,
      earlier: earlier.slice(0, EARLIER_LIMIT),
      total: episodes.length,
      working: roster.some((r) => r.working) || !!live?.running,
      isFresh: (step: EpisodeStep) => now - (arrivals.get(step.id) ?? 0) < SETTLE_MS,
    };
  }, [tasks, episodes, steps, clients, ready, now, arrivals]);
}
