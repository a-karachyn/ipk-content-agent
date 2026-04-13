'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./prompts');
const { redis } = require('./redis');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-sonnet-4-20250514';

const GROUPS_KEY = 'promo:groups';
const PENDING_KEY = 'promo:pending_post';

// ─── Redis: база групп ────────────────────────────────────────────────────────

async function getGroups() {
  const data = await redis.get(GROUPS_KEY);
  return data ? JSON.parse(data) : [];
}

async function saveGroups(groups) {
  await redis.set(GROUPS_KEY, JSON.stringify(groups));
}

// Добавляет новые группы, не дублируя по ссылке
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

// ─── Claude: поиск Telegram-групп ────────────────────────────────────────────

const SEARCH_QUERIES = [
  'застройщики Санкт-Петербург чат',
  'девелоперы недвижимость СПб группа',
  'строительные компании СПб чат',
  'генподряд строительство чат',
  'проектировщики строительство группа',
  'проектные организации СПб чат',
  'архитекторы СПб группа',
  'архитектура и проектирование чат',
  'технадзор строительство группа',
  'технический заказчик строительство чат',
  'BIM проектирование группа',
  'информационное моделирование BIM чат',
  'управляющие компании ЖКХ группа',
  'эксплуатация зданий ЖКХ чат',
  'тендеры строительство госзакупки группа',
  'капремонт строительство чат',
  'недвижимость инвестиции СПб группа',
  'инженерные системы здания чат',
  'пожарная безопасность зданий группа',
  'системы безопасности СКУД чат',
  'умный дом автоматизация зданий группа',
  'эвакуация пожаротушение здания чат',
  'строительный контроль надзор группа',
  'девелопмент коммерческая недвижимость чат',
  'строительство жилых комплексов группа',
];

async function searchGroupsByQuery(query) {
  const prompt = `Найди 5-10 Telegram-групп и чатов (не каналов) по теме: "${query}".
Только группы где можно писать сообщения участникам.
Верни JSON-массив:
[{"name":"...","link":"t.me/...","topic":"...","description":"..."}]
Только JSON, без пояснений.`;

  const messages = [{ role: 'user', content: prompt }];

  for (let i = 0; i < 6; i++) {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 2048,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      },
      { headers: { 'anthropic-beta': 'web-search-2025-03-05' } },
    );

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return [];

      try {
        return JSON.parse(match[0]);
      } catch {
        return [];
      }
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) break;

    messages.push({
      role: 'user',
      content: toolUses.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: [],
      })),
    });
  }

  return [];
}

async function searchGroups() {
  const allGroups = [];
  const seenLinks = new Set();

  for (const query of SEARCH_QUERIES) {
    try {
      const found = await searchGroupsByQuery(query);
      for (const g of found) {
        const link = (g.link || '').trim();
        if (!link || seenLinks.has(link)) continue;
        seenLinks.add(link);
        allGroups.push({
          id: `g_${Date.now()}_${allGroups.length}`,
          name: g.name || 'Без названия',
          link,
          topic: g.topic || query,
          description: g.description || '',
          status: 'active',
          lastPublished: null,
          publishNote: null,
        });
      }
    } catch {
      // пропускаем неудачный запрос, продолжаем
    }

    // пауза между запросами чтобы не превышать rate limit
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!allGroups.length) throw new Error('Не найдено ни одной группы');
  return allGroups;
}

// ─── Claude: генерация промо-поста ───────────────────────────────────────────

async function generatePromoPost(group) {
  const prompt = `Напиши экспертный пост (600–900 символов) для Telegram-группы "${group.name}" (тема: ${group.topic}).
Аудитория: застройщики и заказчики строительства.
Тема: почему экономия на проектировании пожарной безопасности срывает сдачу объекта.
Раскрой одну боль: замечания ГПН/экспертизы, штрафы МЧС или риски при пожаре.
В конце (2–3 строки) упомяни @ipk_proekt и @IPK_zayvki_bot.
Без хэштегов. Без рекламного тона. Не начинай с названия компании.`;

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
  markGroupPublished,
  getPromoPending,
  setPromoPending,
  clearPromoPending,
  pickNextGroup,
  searchGroups,
  generatePromoPost,
};
