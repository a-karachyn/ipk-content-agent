'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { redis } = require('./redis');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-sonnet-4-20250514';

const GROUPS_KEY = 'promo:groups';
const PENDING_KEY = 'promo:pending_post';
const APPROVED_KEY = 'promo:approved_post';

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

// ─── Redis: approved promo post (одобрен, ждёт публикации) ───────────────────

async function getApprovedPromoPending() {
  const { getApprovedPromo } = require('./redis');
  return getApprovedPromo();
}

async function setApprovedPromoPending(data) {
  const { setApprovedPromo } = require('./redis');
  return setApprovedPromo(data);
}

async function clearApprovedPromoPending() {
  const { clearApprovedPromo } = require('./redis');
  return clearApprovedPromo();
}

// ─── Обновление базы групп (для понедельничного cron) ─────────────────────────

async function updatePromoGroups() {
  const found = await searchGroups();
  const result = await mergeGroups(found);
  console.log(`[Promo] Обновление базы групп: найдено ${found.length}, добавлено ${result.added}, всего ${result.total}`);
  return result;
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
  'застройщики девелоперы СПб Telegram чат',
  'строительные компании генподряд Telegram группа',
  'проектировщики архитекторы строительство Telegram чат',
  'технадзор технический заказчик строительство Telegram группа',
  'BIM информационное моделирование строительство Telegram чат',
  'управляющие компании ЖКХ эксплуатация зданий Telegram группа',
  'тендеры госзакупки строительство 44-ФЗ Telegram чат',
  'пожарная безопасность СКУД инженерные системы зданий Telegram группа',
  'умный дом автоматизация зданий строительство Telegram чат',
  'недвижимость инвестиции коммерческая недвижимость СПб Telegram группа',
];

async function searchGroupsByQuery(query) {
  console.log(`[Promo] Поиск по запросу: "${query}"`);

  const prompt = `Найди 10 Telegram-групп и чатов по теме: "${query}".
Ищи ТОЛЬКО открытые публичные Telegram группы и каналы где любой может написать сообщение без одобрения. Исключай закрытые группы, группы только для чтения, группы с модерацией вступления.
Верни JSON-массив из 10 элементов:
[{"name":"...","link":"t.me/...","topic":"...","description":"..."}]
Только JSON, без пояснений.`;

  const messages = [{ role: 'user', content: prompt }];

  for (let i = 0; i < 6; i++) {
    console.log(`[Promo] Итерация ${i + 1} для "${query}"`);

    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 2048,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      },
      { headers: { 'anthropic-beta': 'web-search-2025-03-05' } },
    );

    console.log(`[Promo] stop_reason: ${response.stop_reason}, блоков: ${response.content.length}`);

    if (response.stop_reason === 'end_turn') {
      const raw = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      console.log(`[Promo] Сырой ответ (первые 300 символов): ${raw.slice(0, 300)}`);

      const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const start = clean.indexOf('[');
      const end = clean.lastIndexOf(']');

      console.log(`[Promo] Позиция '[': ${start}, ']': ${end}`);

      if (start === -1 || end === -1) {
        console.log(`[Promo] JSON-массив не найден в ответе для "${query}"`);
        return [];
      }

      try {
        const arr = JSON.parse(clean.slice(start, end + 1));
        console.log(`[Promo] Распарсено групп: ${arr.length} для "${query}"`);
        return arr;
      } catch (err) {
        console.log(`[Promo] Ошибка парсинга JSON для "${query}": ${err.message}`);
        console.log(`[Promo] Фрагмент: ${clean.slice(start, start + 200)}`);
        return [];
      }
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    console.log(`[Promo] tool_use вызовов: ${toolUses.length}`);
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

  console.log(`[Promo] Лимит итераций исчерпан для "${query}"`);
  return [];
}

async function searchGroups() {
  console.log(`[Promo] Запуск поиска по ${SEARCH_QUERIES.length} запросам`);

  const results = await Promise.all(
    SEARCH_QUERIES.map((query) =>
      searchGroupsByQuery(query).catch((err) => {
        console.log(`[Promo] Ошибка запроса "${query}": ${err.message}`);
        return [];
      }),
    ),
  );

  const perQuery = results.map((r, i) => `"${SEARCH_QUERIES[i]}": ${r.length}`);
  console.log(`[Promo] Результаты по запросам:\n  ${perQuery.join('\n  ')}`);

  const seenLinks = new Set();
  const allGroups = [];

  for (const found of results) {
    for (const g of found) {
      const link = (g.link || '').trim();
      if (!link || seenLinks.has(link)) continue;
      seenLinks.add(link);
      allGroups.push({
        id: `g_${Date.now()}_${allGroups.length}`,
        name: g.name || 'Без названия',
        link,
        topic: g.topic || '',
        description: g.description || '',
        status: 'active',
        lastPublished: null,
        publishNote: null,
      });
    }
  }

  console.log(`[Promo] Уникальных групп после дедупликации: ${allGroups.length}`);

  if (!allGroups.length) throw new Error('Не найдено ни одной группы');
  return allGroups;
}

// ─── Claude: генерация промо-поста ───────────────────────────────────────────

async function generatePromoPost(group) {
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const name = group.name.slice(0, 40);
  const prompt = `Напиши пост 150–200 слов для Telegram-группы "${name}".
Аудитория: застройщики и заказчики строительства.
Раскрой одну боль: замечания ГПН или штрафы МЧС из-за ошибок в проектировании пожарной безопасности.
Без рекламного тона. Завершённый текст с логичным концом.
В самом конце добавь:
"Пишите нам: @IPK_zayvki_bot или подписывайтесь на канал: t.me/ipk_proekt"
#пожарнаябезопасность #проектирование #СПб #ИПК`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Удаляет группу по ссылке (частичное совпадение).
async function removeGroup(linkQuery) {
  const groups = await getGroups();
  const needle = linkQuery.trim().toLowerCase().replace(/^https?:\/\//, '');
  const filtered = groups.filter((g) => !g.link.toLowerCase().replace(/^https?:\/\//, '').includes(needle));
  await saveGroups(filtered);
  return groups.length - filtered.length;
}

// Извлекает username из ссылки вида t.me/name или https://t.me/name
function extractUsername(link) {
  const clean = link.replace(/^https?:\/\//, '').replace(/^t\.me\//, '');
  const username = clean.split('/')[0].split('?')[0].trim();
  return username ? `@${username}` : null;
}

/**
 * Проверяет каждую группу через Telegram API.
 * Принимает bot.telegram чтобы избежать циклического импорта.
 * Удаляет недоступные и приватные группы, возвращает статистику.
 */
async function validateGroups(telegram) {
  const groups = await getGroups();
  const valid = [];
  let removed = 0;

  for (const group of groups) {
    const username = extractUsername(group.link || '');
    if (!username) {
      console.log(`[Promo] Пропуск (нет username): ${group.link}`);
      removed++;
      continue;
    }

    try {
      const chat = await telegram.getChat(username);
      if (chat.type === 'private') {
        console.log(`[Promo] Удалена приватная: ${group.link}`);
        removed++;
      } else {
        valid.push(group);
      }
    } catch (err) {
      console.log(`[Promo] Удалена недоступная (${err.message}): ${group.link}`);
      removed++;
    }

    // Пауза между запросами чтобы не превысить rate limit Telegram API
    await new Promise((r) => setTimeout(r, 300));
  }

  await saveGroups(valid);
  console.log(`[Promo] Валидация завершена: проверено ${groups.length}, удалено ${removed}, осталось ${valid.length}`);
  return { total: groups.length, removed, remaining: valid.length };
}

module.exports = {
  getGroups,
  saveGroups,
  mergeGroups,
  markGroupPublished,
  removeGroup,
  validateGroups,
  getPromoPending,
  setPromoPending,
  clearPromoPending,
  getApprovedPromoPending,
  setApprovedPromoPending,
  clearApprovedPromoPending,
  updatePromoGroups,
  pickNextGroup,
  searchGroups,
  generatePromoPost,
};
