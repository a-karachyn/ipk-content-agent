'use strict';

const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL, {
  retryStrategy: (times) => Math.min(times * 200, 5000),
  lazyConnect: false,
});

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));

// ─── Post counter (чередование форматов) ──────────────────────────────────────

async function getPostCount() {
  const val = await redis.get('agent:post_count');
  return parseInt(val || '0', 10);
}

async function incrementPostCount() {
  return redis.incr('agent:post_count');
}

// ─── Pending post (ожидает одобрения менеджера) ───────────────────────────────

async function setPendingPost(post) {
  await redis.set('agent:pending_post', JSON.stringify(post));
}

async function getPendingPost() {
  const val = await redis.get('agent:pending_post');
  return val ? JSON.parse(val) : null;
}

async function clearPendingPost() {
  await redis.del('agent:pending_post');
}

// ─── Case data (данные кейса, собранные у менеджера) ──────────────────────────

async function setCaseField(field, value) {
  await redis.hset('agent:case_draft', field, value);
}

async function getCaseDraft() {
  return redis.hgetall('agent:case_draft');
}

async function clearCaseDraft() {
  await redis.del('agent:case_draft');
}

// ─── Manager conversation state ───────────────────────────────────────────────
// States: idle | editing | collecting_task | collecting_solution | collecting_result

async function setManagerState(state) {
  await redis.set('agent:manager_state', state);
}

async function getManagerState() {
  return (await redis.get('agent:manager_state')) || 'idle';
}

module.exports = {
  redis,
  getPostCount,
  incrementPostCount,
  setPendingPost,
  getPendingPost,
  clearPendingPost,
  setCaseField,
  getCaseDraft,
  clearCaseDraft,
  setManagerState,
  getManagerState,
};
