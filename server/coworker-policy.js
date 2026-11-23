'use strict';
const db = require('./lib/db');
const P = require('./platform');
const W = require('./lib/workspace');

const FLAGS = ['enabled', 'follow_ups', 'dashboards', 'slack'];
const LIMITS = { retention_days: 3650, daily_ai_calls: 100000 };
const DEFAULT = { enabled: true, follow_ups: true, dashboards: true, slack: true, retention_days: null, daily_ai_calls: null, follow_up_epoch: 0, updated_at: null, updated_by: null };

function get(t, lock = false) {
  const row = db.get('SELECT * FROM coworker_policies WHERE tenant_id=?' + (lock && db.mode() === 'pg' ? ' FOR SHARE' : ''), t);
  if (!row) return { ...DEFAULT };
  const { tenant_id, ...policy } = row;
  for (const key of FLAGS) policy[key] = policy[key] === 1;
  return policy;
}

function capabilities(t, user, policy = get(t)) {
  const writable = policy.enabled && user.role !== 'viewer';
  return {
    enabled: policy.enabled,
    follow_ups: writable && policy.follow_ups && !W.pending(t),
    dashboards: writable && policy.dashboards,
  };
}

function cutoff(retentionDays, now = Date.now()) {
  return retentionDays === null ? '' : new Date(now - retentionDays * 864e5).toISOString();
}

function prune(t, retentionDays) {
  if (retentionDays === null) return 0;
  const before = cutoff(retentionDays);
  const removed = db.run('DELETE FROM chat_messages WHERE tenant_id=? AND created_at<?', t, before).changes;
  db.run('DELETE FROM coworker_chats WHERE tenant_id=? AND updated_at<?', t, before);
  return removed;
}

function pruneExpired() {
  for (const row of db.all('SELECT tenant_id FROM coworker_policies WHERE retention_days IS NOT NULL')) {
    db.tx(() => {
      const lock = db.mode() === 'pg' ? ' FOR UPDATE' : '';
      const policy = db.get('SELECT retention_days FROM coworker_policies WHERE tenant_id=?' + lock, row.tenant_id);
      if (policy) prune(row.tenant_id, policy.retention_days);
    });
  }
}

const usageKey = () => 'coworker_ai_attempts:' + new Date().toISOString().slice(0, 10);
function settings(t) {
  return { policy: get(t), ai_calls_today: P.counter(t, usageKey()), limits: LIMITS };
}

function reserveAiCall(t, source) {
  // Reserve before sending the question. A single upsert enforces the workspace budget across processes.
  return !!db.run(`
    INSERT INTO counters(tenant_id,key,value)
    SELECT ?,?,1 WHERE COALESCE((SELECT enabled FROM coworker_policies WHERE tenant_id=?),1)=1
      AND (?<>'slack' OR COALESCE((SELECT slack FROM coworker_policies WHERE tenant_id=?),1)=1)
      AND COALESCE((SELECT daily_ai_calls FROM coworker_policies WHERE tenant_id=?),1)>0
    ON CONFLICT(tenant_id,key) DO UPDATE SET value=counters.value+1
      WHERE counters.value<COALESCE((SELECT daily_ai_calls FROM coworker_policies WHERE tenant_id=?),9007199254740991)
  `, t, usageKey(), t, source, t, t, t).changes;
}

function save(t, user, input) {
  for (const key of FLAGS) {
    if (typeof input?.[key] !== 'boolean') throw new P.HttpError(400, 'Choose whether each coworker capability is allowed.');
  }
  for (const [key, max] of Object.entries(LIMITS)) {
    const value = input[key], min = key === 'retention_days' ? 1 : 0;
    if (value !== null && (!Number.isInteger(value) || value < min || value > max)) {
      const label = key === 'retention_days' ? 'Retention days' : 'Daily AI requests';
      throw new P.HttpError(400, label + ' must be blank or a whole number from ' + min + ' to ' + max + '.');
    }
  }
  return db.tx(() => {
    const [enabled, followUps, dashboards, slack] = FLAGS.map((key) => Number(input[key]));
    const before = get(t);
    const nextEpoch = Number(before.enabled !== input.enabled || before.follow_ups !== input.follow_ups);
    db.run(`
      INSERT INTO coworker_policies(tenant_id,enabled,follow_ups,dashboards,slack,retention_days,daily_ai_calls,follow_up_epoch,updated_at,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled,follow_ups=excluded.follow_ups,
        dashboards=excluded.dashboards,slack=excluded.slack,retention_days=excluded.retention_days,daily_ai_calls=excluded.daily_ai_calls,
        follow_up_epoch=coworker_policies.follow_up_epoch+
          CASE WHEN coworker_policies.enabled<>excluded.enabled OR coworker_policies.follow_ups<>excluded.follow_ups THEN 1 ELSE 0 END,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by
    `, t, enabled, followUps, dashboards, slack, input.retention_days, input.daily_ai_calls, nextEpoch, new Date().toISOString(), user.name);
    const removed = prune(t, input.retention_days);
    const { policy, ai_calls_today, limits } = settings(t);
    P.audit(t, 'COWORKER_POLICY_UPDATED', 'Coworker policy', 'Updated coworker capabilities, retention and AI usage limits.', user, {
      detail: { actor_id: user.id, before, policy, messages_removed: removed },
    });
    return { policy, ai_calls_today, limits, capabilities: capabilities(t, user, policy) };
  });
}

module.exports = { get, capabilities, cutoff, pruneExpired, settings, reserveAiCall, save };
