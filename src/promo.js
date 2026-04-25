'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { redis } = require('./redis');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-haiku-4-5-20251001';

// ─── Redis ключи ──────────────────────────────────────────────────────────────

const KEYS = {
  all:       'promo:groups:all',
  week:      'promo:groups:week',
  used:      'promo:groups:used',
  pending:   'promo:pending_post',
  approved:  'promo:approved_post',
};

// ─── Статический сид ──────────────────────────────────────────────────────────

const STATIC_GROUPS = [
  { name: 'ПТОшники & ПРОектировщики',         link: 'https://t.me/pro_pto',            topic: 'Проектировщики' },
  { name: 'Проектировщики РФ',                  link: 'https://t.me/proektirovshiki',    topic: 'Проектировщики' },
  { name: 'Проектирование и экспертиза',         link: 'https://t.me/proekt_expertiza',   topic: 'Проектировщики' },
  { name: 'Проектировщики инженерных систем',    link: 'https://t.me/inzh_proekt',        topic: 'Проектировщики' },
  { name: 'BIM проектирование Россия',           link: 'https://t.me/RevitoBIM',          topic: 'BIM проектирование' },
  { name: 'Архитекторы и проектировщики',        link: 'https://t.me/arch_proekt',        topic: 'Проектировщики' },
  { name: 'Проектная документация и экспертиза', link: 'https://t.me/proekt_docs',        topic: 'Проектировщики' },
  { name: 'Инженерное проектирование',           link: 'https://t.me/engineering_design', topic: 'Проектировщики' },
  { name: 'Технический заказчик',                link: 'https://t.me/tech_zakazchik',     topic: 'Технадзор' },
  { name: 'Строительный бизнес РФ',              link: 'https://t.me/stroybiz_rf',        topic: 'Строители' },
  { name: 'Девелопмент и стройка',               link: 'https://t.me/development_stroy',  topic: 'Девелоперы' },
  { name: 'Коммерческая недвижимость СПб',       link: 'https://t.me/commercial_spb',     topic: 'Девелоперы' },
  { name: 'Промышленное строительство',          link: 'https://t.me/industrial_build',   topic: 'Промышленность' },
  { name: 'Госзакупки строительство',            link: 'https://t.me/goszakupki_build',   topic: 'Тендеры' },
  { name: 'Недвижимость СПб чат',               link: 'https://t.me/nedvizo_spb',        topic: 'Недвижимость' },
  { name: 'Строители РФ чат',                   link: 'https://t.me/stroiteli_rf_chat',  topic: 'Строители' },
  { name: 'Тендеры и закупки строительство',     link: 'https://t.me/zakupkiChat',        topic: 'Тендеры' },
  { name: 'Инвесторы в недвижимость СПб',        link: 'https://t.me/invest_spb_realty',  topic: 'Инвесторы' },
  { name: 'Управление строительными проектами',  link: 'https://t.me/pm_construction',    topic: 'Технадзор' },
  { name: 'Пожарная безопасность зданий',        link: 'https://t.me/fire_safety_ru',     topic: 'Пожарная безопасность' },
];

const TGSTAT_KEYWORDS = [
  'проектирование',
  'инженерное проектирование',
  'пожарная безопасность',
  'строительное проектирование',
  'проектировщики',
  'технадзор',
  'застройщик СПб',
  'девелопер строительство',
  'BIM проектирование',
  'экспертиза проектная документация',
];

// ─── Redis helpers ────────────────────────────────────────────────────────────

async function getAllGroups() {
  const data = await redis.get(KEYS.all);
  if (data) return JSON.parse(data);
  const seeded = STATIC_GROUPS.map((g, i) => ({ id: `static_${i}`, ...g }));
  await saveAllGroups(seeded);
  console.log(`[Promo] База инициализирована из STATIC_GROUPS: ${seeded.length} групп`);
  return seeded;
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
  const filtered = used.filter((u) => u.link !== group.link);
  filtered.push({ ...group, usedAt: new Date().toISOString() });
  await saveUsedGroups(filtered);
}

async function removeFromWeekQueue(link) {
  const queue = await getWeekQueue();
  await saveWeekQueue(queue.filter((g) => g.link !== link));
}

// ─── ШАГ 1: поиск групп через tgstat.ru ──────────────────────────────────────

async function scrapeGroupsByKeyword(keyword) {
  const url = `https://tgstat.ru/search?q=${encodeURIComponent(keyword)}&type=group`;
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IPKContentBot/1.0)',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    });
    if (!res.ok) {
      console.log(`[Promo] tgstat.ru ${res.status} для "${keyword}"`);
      return [];
    }
    html = await res.text();
  } catch (err) {
    console.log(`[Promo] Ошибка tgstat.ru для "${keyword}": ${err.message}`);
    return [];
  }

  const regex = /https?:\/\/t\.me\/([a-zA-Z0-9_]{5,32})/g;
  const found = new Set();
  let match;
  while ((match = regex.exec(html)) !== null) {
    const username = match[1].toLowerCase();
    if (['joinchat', 'share', 'iv', 'proxy', 'addstickers'].includes(username)) continue;
    found.add(`https://t.me/${match[1]}`);
  }

  console.log(`[Promo] tgstat "${keyword}": ${found.size} ссылок`);
  return Array.from(found);
}

async function updatePromoGroups() {
  console.log('[Promo] Обновление базы через tgstat.ru...');
  const all = await getAllGroups();
  const existingLinks = new Set(all.map((g) => g.link));
  let added = 0;

  for (const keyword of TGSTAT_KEYWORDS) {
    const links = await scrapeGroupsByKeyword(keyword);
    for (const link of links) {
      if (!existingLinks.has(link)) {
        existingLinks.add(link);
        all.push({
          id: `tg_${Date.now()}_${added}`,
          name: link.replace('https://t.me/', '@'),
          link,
          topic: keyword,
        });
        added++;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  await saveAllGroups(all);
  console.log(`[Promo] Обновление завершено: +${added} новых, всего ${all.length}`);
  return { added, total: all.length };
}

// ─── ШАГ 2: формирование очереди на неделю ───────────────────────────────────

async function buildWeekQueue() {
  const all = await getAllGroups();
  const used = await getUsedGroups();
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentLinks = new Set(
    used.filter((u) => new Date(u.usedAt).getTime() > thirtyDaysAgo).map((u) => u.link),
  );

  let available = all.filter((g) => !recentLinks.has(g.link));

  if (available.length < 7) {
    console.log('[Promo] Все группы охвачены — сброс истории использования');
    await saveUsedGroups([]);
    available = all;
  }

  const queue = available.slice(0, 14);
  await saveWeekQueue(queue);
  console.log(`[Promo] Очередь на неделю: ${queue.length} групп`);
  return queue;
}

// ─── ШАГ 3: валидация очереди ─────────────────────────────────────────────────

async function validateWeekQueue(telegram) {
  const queue = await getWeekQueue();
  const all = await getAllGroups();
  const valid = [];
  let removed = 0;

  for (const group of queue) {
    const username = extractUsername(group.link);
    if (!username) { removed++; continue; }
    try {
      const chat = await telegram.getChat(username);
      if (chat.type === 'private') {
        console.log(`[Promo] Приватная, удалена: ${group.link}`);
        removed++;
      } else {
        valid.push(group);
      }
    } catch (err) {
      console.log(`[Promo] Недоступна, удалена (${err.message}): ${group.link}`);
      removed++;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (removed > 0) {
    const queueLinks = new Set(valid.map((g) => g.link));
    const used = await getUsedGroups();
    const usedLinks = new Set(used.map((u) => u.link));
    const extras = all
      .filter((g) => !queueLinks.has(g.link) && !usedLinks.has(g.link))
      .slice(0, removed);
    valid.push(...extras);
    console.log(`[Promo] Добавлено ${extras.length} замен`);
  }

  await saveWeekQueue(valid);
  console.log(`[Promo] Валидация: удалено ${removed}, в очереди ${valid.length}`);
  return { removed, remaining: valid.length };
}

// ─── ШАГ 4: генерация промо-поста ────────────────────────────────────────────

async function generatePromoPost(group) {
  await new Promise((r) => setTimeout(r, 3000));

  const name = group.name.slice(0, 40);
  const prompt = `Напиши пост 150 слов для Telegram-группы "${name}".
Аудитория: застройщики и заказчики строительства.
Раскрой одну боль: замечания ГПН или штрафы МЧС из-за ошибок в проектировании пожарной безопасности.
В конце добавь: "Пишите нам: @IPK_zayvki_bot или подписывайтесь на канал: t.me/ipk_proekt"
#пожарнаябезопасность #проектирование #СПб #ИПК
Без рекламного тона. Завершённый текст.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ─── Pending / Approved (используется из bot.js) ──────────────────────────────

async function getPromoPending() {
  const data = await redis.get(KEYS.pending);
  return data ? JSON.parse(data) : null;
}

async function setPromoPending(data) {
  await redis.set(KEYS.pending, JSON.stringify(data));
}

async function clearPromoPending() {
  await redis.del(KEYS.pending);
}

async function getApprovedPromoPending() {
  const data = await redis.get(KEYS.approved);
  return data ? JSON.parse(data) : null;
}

async function setApprovedPromoPending(data) {
  await redis.set(KEYS.approved, JSON.stringify(data));
}

async function clearApprovedPromoPending() {
  await redis.del(KEYS.approved);
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function extractUsername(link) {
  const clean = (link || '').replace(/^https?:\/\//, '').replace(/^t\.me\//, '');
  const username = clean.split('/')[0].split('?')[0].trim();
  return username ? `@${username}` : null;
}

async function addGroup(link, name) {
  const normalizedLink = link.startsWith('http') ? link : `https://t.me/${link.replace(/^@/, '')}`;
  const all = await getAllGroups();
  if (all.some((g) => g.link === normalizedLink)) return false;
  all.push({
    id: `manual_${Date.now()}`,
    name: name || normalizedLink.replace('https://t.me/', '@'),
    link: normalizedLink,
    topic: 'ручное добавление',
  });
  await saveAllGroups(all);
  return true;
}

async function removeGroup(linkQuery) {
  const needle = linkQuery.trim().toLowerCase().replace(/^https?:\/\//, '');
  const all = await getAllGroups();
  const filtered = all.filter((g) => !g.link.toLowerCase().replace(/^https?:\/\//, '').includes(needle));
  await saveAllGroups(filtered);
  const week = await getWeekQueue();
  await saveWeekQueue(week.filter((g) => !g.link.toLowerCase().replace(/^https?:\/\//, '').includes(needle)));
  return all.length - filtered.length;
}

module.exports = {
  getAllGroups,
  getWeekQueue,
  saveWeekQueue,
  getUsedGroups,
  markGroupUsed,
  removeFromWeekQueue,
  updatePromoGroups,
  buildWeekQueue,
  validateWeekQueue,
  generatePromoPost,
  getPromoPending,
  setPromoPending,
  clearPromoPending,
  getApprovedPromoPending,
  setApprovedPromoPending,
  clearApprovedPromoPending,
  extractUsername,
  addGroup,
  removeGroup,
};
