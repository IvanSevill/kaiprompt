import crypto from 'node:crypto';

import {
  loadHiddenConversations, loadQueue, loadSessions, mutateHiddenConversations,
} from '../storage/repositories.mjs';
import { nid } from './identity.mjs';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
export const compatibilityConversationId = (key) => `compat-${digest(String(key))}`;
export const newConversationId = () => `${nid('c')}-${crypto.randomBytes(6).toString('hex')}`;

export function conversationIdForJob(job, { queue = loadQueue(), sessions = loadSessions() } = {}) {
  if (job.conversationId) return job.conversationId;
  const adapter = job.adapter || 'claude';
  const record = job.target ? sessions[job.target]?.engines?.[adapter] ?? (
    sessions[job.target]?.adapter === adapter ? sessions[job.target] : null
  ) : null;
  if (record?.conversationId) return record.conversationId;
  const lane = queue.find((candidate) => candidate.id !== job.id && candidate.adapter === adapter
    && ((job.target && candidate.target === job.target)
      || (!job.target && job.sessionId && candidate.sessionId === job.sessionId)));
  if (lane?.conversationId) return lane.conversationId;
  if (job.sessionId) return compatibilityConversationId(`session:${adapter}:${job.sessionId}`);
  if (job.target) return compatibilityConversationId(`target:${adapter}:${job.target}`);
  return compatibilityConversationId(`job:${job.id}`);
}

export function conversationIdForRecord(target, record, jobs = []) {
  return record?.conversationId
    ?? jobs.find((job) => job.conversationId)?.conversationId
    ?? (record?.sessionId
      ? compatibilityConversationId(`session:${record.adapter || 'claude'}:${record.sessionId}`)
      : jobs[0] ? conversationIdForJob(jobs[0], { queue: jobs, sessions: {} })
        : compatibilityConversationId(`target:${record?.adapter || 'claude'}:${target}`));
}

export const conversationAlias = (conversationId, target, adapter, sessionId, ordinal = 0) =>
  compatibilityConversationId(`alias:${conversationId}:${target ?? ''}:${adapter ?? ''}:${sessionId ?? ''}:${ordinal}`);

export function hiddenConversationIds() {
  const value = loadHiddenState();
  return new Set(Array.isArray(value.conversationIds) ? value.conversationIds : []);
}

export const loadHiddenState = () => loadHiddenConversations();

export function hideConversationIds(ids) {
  const requested = new Set(ids);
  let added = 0;
  const state = mutateHiddenConversations((current) => {
    const existing = new Set(Array.isArray(current.conversationIds) ? current.conversationIds : []);
    for (const id of requested) if (!existing.has(id)) { existing.add(id); added++; }
    return { ...current, conversationIds: [...existing].sort() };
  });
  return { added, total: state.conversationIds.length };
}
