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

// ─── MAX Content: pending post (из max-content-agent) ────────────────────────

async function getMaxPendingPost() {
  const val = await redis.get('max_content:pending_post');
  return val ? JSON.parse(val) : null;
}

async function setMaxPendingPost(post) {
  await redis.set('max_content:pending_post', JSON.stringify(post));
}

async function clearMaxPendingPost() {
  await redis.del('max_content:pending_post');
}

// ─── MAX Content: manager state ───────────────────────────────────────────────
// States: idle | max_editing | max_collecting_task | max_collecting_solution
//         max_collecting_result | max_confirming_promo | max_editing_promo

async function getMaxManagerState() {
  return (await redis.get('max_content:manager_state')) || 'idle';
}

async function setMaxManagerState(state) {
  await redis.set('max_content:manager_state', state);
}

// ─── MAX Content: case draft ──────────────────────────────────────────────────

async function setMaxCaseField(field, value) {
  await redis.hset('max_content:case_draft', field, value);
}

async function getMaxCaseDraft() {
  return redis.hgetall('max_content:case_draft');
}

async function clearMaxCaseDraft() {
  await redis.del('max_content:case_draft');
}

// ─── Content format counter (чередование 1→2→3→1...) ─────────────────────────

async function getFormatCounter() {
  const val = await redis.get('content:post_format_counter');
  return parseInt(val || '0', 10);
}

async function incrementFormatCounter() {
  return redis.incr('content:post_format_counter');
}

// ─── Approved promo post (одобрен, ждёт публикации в 11:00 или 20:00) ────────

async function getApprovedPromo() {
  const val = await redis.get('promo:approved_post');
  return val ? JSON.parse(val) : null;
}

async function setApprovedPromo(data) {
  await redis.set('promo:approved_post', JSON.stringify(data));
}

async function clearApprovedPromo() {
  await redis.del('promo:approved_post');
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
  // Format counter
  getFormatCounter,
  incrementFormatCounter,
  // Approved promo
  getApprovedPromo,
  setApprovedPromo,
  clearApprovedPromo,
  // MAX content
  getMaxPendingPost,
  setMaxPendingPost,
  clearMaxPendingPost,
  getMaxManagerState,
  setMaxManagerState,
  setMaxCaseField,
  getMaxCaseDraft,
  clearMaxCaseDraft,
};
