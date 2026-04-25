'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { redis } = require('./redis');
const { maxRequest } = require('./max');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-haiku-4-5-20251001';

const KEYS = {
  all:     'max_promo:groups:all',
  week:    'max_promo:groups:week',
  used:    'max_promo:groups:used',
  pending: 'max_promo:pending_post',
};

const SEARCH_KEYWORDS = [
  'проектирование',
  'строительство',
  'застройщик',
  'девелопер',
  'недвижимость',
  'архитектура',
  'BIM',
  'технадзор',
  'пожарная безопасность',
  'инженерные системы',
];

// ─── Redis helpers ────────────────────────────────────────────────────────────

async function getAllGroups() {
  const data = await redis.get(KEYS.all);
  return data ? JSON.parse(data) : [];
}

async function saveAllGroups(groups) {
  await redis.set(KEYS.all, JSON.stringify(groups));
}

async function getWeekQueue() {
  const data = await redis.get(KEYS.week);
  return data ? JSON.parse(data) : [];
}

async function saveWeekQueue(groups) {
  await redis.set(KEYS.week, JSON.stringify(groups));
}

async function getUsedGroups() {
  const data = await redis.get(KEYS.used);
  return data ? JSON.parse(data) : [];
}

async function saveUsedGroups(groups) {
  await redis.set(KEYS.used, JSON.stringify(groups));
}

async function markGroupUsed(group) {
  const used = await getUsedGroups();
  const filtered = used.filter((u) => u.chatId !== group.chatId);
  filtered.push({ ...group, usedAt: new Date().toISOString() });
  await saveUsedGroups(filtered);
}

async function removeFromWeekQueue(chatId) {
  const queue = await getWeekQueue();
  await saveWeekQueue(queue.filter((g) => g.chatId !== chatId));
}

// ─── Pending post ────────────────────────────────────────────────────────────

async function getMaxPromoPending() {
  const data = await redis.get(KEYS.pending);
  return data ? JSON.parse(data) : null;
}

async function setMaxPromoPending(data) {
  await redis.set(KEYS.pending, JSON.stringify(data));
}

async function clearMaxPromoPending() {
  await redis.del(KEYS.pending);
}

// ─── ШАГ 1: поиск сообществ через MAX API ────────────────────────────────────

async function searchByKeyword(keyword) {
  try {
    const path = `/chats?type=channel&title=${encodeURIComponent(keyword)}&count=10`;
    const data = await maxRequest('GET', path);
    return Array.isArray(data?.chats) ? data.chats : [];
  } catch {
    return [];
  }
}

async function updateMaxPromoGroups() {
  console.log('[MaxPromo] Обновление базы через MAX API...');
  const all = await getAllGroups();
  const existingIds = new Set(all.map((g) => g.chatId));
  let added = 0;

  const results = await Promise.all(SEARCH_KEYWORDS.map((kw) => searchByKeyword(kw)));

  for (const chats of results) {
    for (const chat of chats) {
      const chatId = String(chat.chat_id ?? chat.id ?? '');
      if (!chatId || existingIds.has(chatId)) continue;
      existingIds.add(chatId);
      all.push({
        id: `mg_${chatId}`,
        name: chat.title || chat.name || 'Без названия',
        link: chat.invite_link || chat.link || `max.ru/chat/${chatId}`,
        topic: chat.description || '',
        chatId,
      });
      added++;
    }
  }

  await saveAllGroups(all);
  console.log(`[MaxPromo] Обновление завершено: +${added} новых, всего ${all.length}`);
  return { added, total: all.length };
}

// ─── ШАГ 2: формирование очереди на неделю ───────────────────────────────────

async function buildMaxWeekQueue() {
  const all = await getAllGroups();
  if (!all.length) {
    console.log('[MaxPromo] База пуста, очередь не сформирована');
    return [];
  }

  const used = await getUsedGroups();
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentIds = new Set(
    used.filter((u) => new Date(u.usedAt).getTime() > thirtyDaysAgo).map((u) => u.chatId),
  );

  let available = all.filter((g) => !recentIds.has(g.chatId));

  if (available.length < 7) {
    console.log('[MaxPromo] Все сообщества охвачены — сброс истории использования');
    await saveUsedGroups([]);
    available = all;
  }

  const queue = available.slice(0, 14);
  await saveWeekQueue(queue);
  console.log(`[MaxPromo] Очередь на неделю: ${queue.length} сообществ`);
  return queue;
}

// ─── ШАГ 3: генерация промо-поста ─────────────────────────────────────────────

async function generateMaxPromoPost(group) {
  await new Promise((r) => setTimeout(r, 3000));

  const name = group.name.slice(0, 40);
  const prompt = `Напиши пост 150 слов для MAX-сообщества "${name}".
Аудитория: застройщики и заказчики строительства.
Раскрой одну боль: замечания ГПН или штрафы МЧС из-за ошибок в проектировании пожарной безопасности.
В конце добавь: "Пишите нам: @IPK_zayvki_bot или подписывайтесь: max.ru/id351000349259_biz"
Без хэштегов. Без HTML тегов. Без рекламного тона. Завершённый текст.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ─── Добавление вручную ───────────────────────────────────────────────────────

async function addGroup(name, link, topic = '') {
  const all = await getAllGroups();
  if (all.some((g) => g.link === link)) return false;
  const chatId = `manual_${Date.now()}`;
  all.push({ id: `mg_${chatId}`, name, link, topic, chatId });
  await saveAllGroups(all);
  return true;
}

// ─── Публикация в MAX сообщество ─────────────────────────────────────────────

async function publishToMaxGroup(group, text) {
  if (!group.chatId || group.chatId.startsWith('manual_')) {
    throw new Error('no_chat_id');
  }
  return maxRequest('POST', `/messages?chat_id=${encodeURIComponent(group.chatId)}`, { text });
}

module.exports = {
  getAllGroups,
  getWeekQueue,
  saveWeekQueue,
  getUsedGroups,
  markGroupUsed,
  removeFromWeekQueue,
  updateMaxPromoGroups,
  buildMaxWeekQueue,
  generateMaxPromoPost,
  getMaxPromoPending,
  setMaxPromoPending,
  clearMaxPromoPending,
  addGroup,
  publishToMaxGroup,
};
