'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./prompts');
const { redis } = require('./redis');

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

// ─── Статический список целевых площадок для исследования ────────────────────
// MAX — молодой мессенджер, публичных сообществ пока мало.
// Менеджер вручную находит реальные MAX-аккаунты и добавляет через /max_promo_add.

const SEED_TARGETS = [
  // Крупные застройщики СПб
  { name: 'ЛСР Недвижимость', category: 'застройщик', description: 'Один из крупнейших застройщиков СПб' },
  { name: 'Setl Group', category: 'застройщик', description: 'Крупнейший застройщик Северо-Запада' },
  { name: 'ПИК — Санкт-Петербург', category: 'застройщик', description: 'Федеральный застройщик, проекты в СПб' },
  { name: 'Группа ЦДС', category: 'застройщик', description: 'Застройщик жилья в СПб и ЛО' },
  { name: 'RBI (RBI Group)', category: 'застройщик', description: 'Застройщик бизнес- и премиум-класса СПб' },
  { name: 'Группа Эталон', category: 'застройщик', description: 'Федеральный застройщик, крупные проекты в СПб' },
  { name: 'КВС Группа', category: 'застройщик', description: 'Застройщик комфорт-класса в СПб и ЛО' },
  { name: 'Строительный трест', category: 'застройщик', description: 'Застройщик и генподрядчик СПб' },
  { name: 'Legenda Intelligent Development', category: 'застройщик', description: 'Застройщик smart-жилья в СПб' },
  { name: 'Glorax Development', category: 'застройщик', description: 'Девелопер жилья и коммерческой недвижимости' },

  // Генподрядчики и строительные компании
  { name: 'Холдинг Адамант', category: 'девелопер/УК', description: 'Коммерческая недвижимость и ТРЦ СПб' },
  { name: 'AAG (Агентство. Аналитика. Геодезия)', category: 'застройщик', description: 'Застройщик бизнес-класса СПб' },
  { name: 'Бонава Санкт-Петербург', category: 'застройщик', description: 'Скандинавский застройщик в СПб' },
  { name: 'ФСК (Федеральная Строительная Компания)', category: 'генподрядчик', description: 'Один из крупнейших генподрядчиков РФ' },
  { name: 'Группа ЛенСпецСМУ', category: 'генподрядчик', description: 'Генподрядчик и застройщик СПб' },

  // Профессиональные сообщества
  { name: 'Союз строителей СПб', category: 'профсообщество', description: 'Отраслевой союз строительных компаний СПб' },
  { name: 'НОСТРОЙ — Северо-Запад', category: 'профсообщество', description: 'Нац. объединение строителей, СЗФО' },
  { name: 'НОПРИЗ — Северо-Запад', category: 'профсообщество', description: 'Нац. объединение проектировщиков, СЗФО' },
  { name: 'BIM-сообщество СПб', category: 'BIM/цифровое', description: 'Специалисты по BIM и цифровому строительству' },
  { name: 'Гильдия управляющих и девелоперов', category: 'профсообщество', description: 'ГУД — профсообщество девелоперов и УК' },

  // Управляющие компании и эксплуатация
  { name: 'Управляющая компания ЖКС', category: 'УК/ЖКХ', description: 'Крупная УК в СПб' },
  { name: 'Лидер (УК)', category: 'УК/ЖКХ', description: 'Управление жилой и коммерческой недвижимостью' },
  { name: 'Группа компаний ПСК', category: 'генподрядчик', description: 'Промышленное и гражданское строительство' },
  { name: 'Технадзор СПб', category: 'технадзор', description: 'Сообщество специалистов технического надзора СПб' },
  { name: 'Архитекторы СПб', category: 'архитекторы', description: 'Профессиональное сообщество архитекторов города' },
];

function getSeedTargets() {
  return SEED_TARGETS.map((t, idx) => ({
    id: `mg_seed_${idx}`,
    name: t.name,
    link: '',
    topic: t.category,
    description: t.description,
    status: 'research',   // ещё не найдено в MAX — требует поиска менеджером
    lastPublished: null,
    publishNote: null,
  }));
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
  getSeedTargets,
  markGroupPublished,
  getPromoPending,
  setPromoPending,
  clearPromoPending,
  pickNextGroup,
  generatePromoPost,
};
