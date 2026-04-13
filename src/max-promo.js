'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./prompts');
const { redis } = require('./redis');
const { maxRequest } = require('./max');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

const GROUPS_KEY = 'max_promo:groups';
const PENDING_KEY = 'max_promo:pending_post';

// ─── Redis: база MAX сообществ ────────────────────────────────────────────────

async function getGroups() {
  const data = await redis.get(GROUPS_KEY);
  return data ? JSON.parse(data) : [];
}

async function saveGroups(groups) {
  await redis.set(GROUPS_KEY, JSON.stringify(groups));
}

async function mergeGroups(newGroups) {
  const existing = await getGroups();
  const existingLinks = new Set(existing.map((g) => g.link));
  const toAdd = newGroups.filter((g) => !existingLinks.has(g.link));
  const merged = [...existing, ...toAdd];
  await saveGroups(merged);
  return { added: toAdd.length, total: merged.length };
}

async function markGroupPublished(groupId, note) {
  const groups = await getGroups();
  const idx = groups.findIndex((g) => g.id === groupId);
  if (idx !== -1) {
    groups[idx].lastPublished = new Date().toISOString();
    groups[idx].publishNote = note;
  }
  await saveGroups(groups);
}

// ─── Redis: pending promo post ────────────────────────────────────────────────

async function getPromoPending() {
  const data = await redis.get(PENDING_KEY);
  return data ? JSON.parse(data) : null;
}

async function setPromoPending(data) {
  await redis.set(PENDING_KEY, JSON.stringify(data));
}

async function clearPromoPending() {
  await redis.del(PENDING_KEY);
}

// ─── Выбор следующей группы ───────────────────────────────────────────────────

function pickNextGroup(groups, excludeId = null) {
  const active = groups.filter((g) => g.status === 'active' && g.id !== excludeId);
  if (!active.length) return null;
  return active.sort((a, b) => {
    if (!a.lastPublished && !b.lastPublished) return 0;
    if (!a.lastPublished) return -1;
    if (!b.lastPublished) return 1;
    return new Date(a.lastPublished) - new Date(b.lastPublished);
  })[0];
}

// ─── MAX API: поиск сообществ ─────────────────────────────────────────────────

const SEARCH_KEYWORDS = [
  'застройщики',
  'строители',
  'проектировщики',
  'девелоперы',
  'архитекторы',
  'недвижимость СПб',
  'строительство СПб',
  'BIM',
  'технадзор',
  'генподряд',
  'капремонт',
  'ЖКХ',
  'управляющая компания',
  'тендеры строительство',
  'инженерные системы',
];

async function searchByKeyword(keyword) {
  try {
    const path = `/chats?type=channel&title=${encodeURIComponent(keyword)}&count=10`;
    const data = await maxRequest('GET', path);
    return Array.isArray(data?.chats) ? data.chats : [];
  } catch {
    return [];
  }
}

async function searchGroups() {
  const results = await Promise.all(SEARCH_KEYWORDS.map((kw) => searchByKeyword(kw)));

  const seenIds = new Set();
  const allGroups = [];

  for (const chats of results) {
    for (const chat of chats) {
      const chatId = String(chat.chat_id ?? chat.id ?? '');
      if (!chatId || seenIds.has(chatId)) continue;
      seenIds.add(chatId);
      allGroups.push({
        id: `mg_${chatId}`,
        name: chat.title || chat.name || 'Без названия',
        link: chat.invite_link || chat.link || `max.ru/chat/${chatId}`,
        topic: chat.description || '',
        description: chat.description || '',
        chatId,
        status: 'active',
        lastPublished: null,
        publishNote: null,
      });
    }
  }

  if (!allGroups.length) throw new Error('MAX API не вернул ни одного сообщества');
  return allGroups;
}

async function addGroup(name, link, topic = '', description = '') {
  const existing = await getGroups();
  const existingLinks = new Set(existing.map((g) => g.link));
  if (existingLinks.has(link)) return { added: false, total: existing.length };

  const group = {
    id: `mg_${Date.now()}`,
    name,
    link,
    topic,
    description,
    status: 'active',
    lastPublished: null,
    publishNote: null,
  };
  const updated = [...existing, group];
  await saveGroups(updated);
  return { added: true, total: updated.length, group };
}

// ─── Claude: генерация промо-поста для MAX ───────────────────────────────────

async function generatePromoPost(group) {
  const prompt = `Напиши экспертный пост (600–900 символов) для сообщества MAX "${group.name}" (тема: ${group.topic}).
Аудитория: застройщики и заказчики строительства.
Тема: почему экономия на проектировании пожарной безопасности срывает сдачу объекта.
Раскрой одну боль: замечания ГПН/экспертизы, штрафы МЧС или риски при пожаре.
В конце (2–3 строки) упомяни сообщество ИПК в MAX (max.ru/id351000349259_biz).
Только чистый текст с эмодзи. Без HTML-тегов. Без хэштегов. Без рекламного тона. Не начинай с названия компании.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

module.exports = {
  getGroups,
  saveGroups,
  mergeGroups,
  addGroup,
  searchGroups,
  markGroupPublished,
  getPromoPending,
  setPromoPending,
  clearPromoPending,
  pickNextGroup,
  generatePromoPost,
};
