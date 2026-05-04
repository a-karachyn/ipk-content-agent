'use strict';

const cron = require('node-cron');
const { getFormatCounter, incrementFormatCounter, getPendingPost, getCaseDraft, clearCaseDraft } = require('./redis');
const { generateCasePost, generateFormatPost } = require('./agent');
const { sendForApproval, startCaseCollection, sendDailyPromoForApproval } = require('./bot');
const { updatePromoGroups, buildWeekQueue, validateWeekQueue, getWeekQueue, generatePromoPost } = require('./promo');
const { sendDailyMaxPromoForApproval } = require('./max-commands');
const { updateMaxPromoGroups, buildMaxWeekQueue, getWeekQueue: getMaxWeekQueue, generateMaxPromoPost } = require('./max-promo');

/**
 * Каждый день в 10:00 по Москве генерируем пост.
 * Если есть данные кейса — публикуем кейс.
 * Иначе чередуем три формата: 1-НОРМАТИВ → 2-ТРЕНДЫ → 3-ИСТОРИЯ → 1...
 */
function schedulePostGeneration() {
  cron.schedule(
    '0 10 * * *',
    async () => {
      console.log('[Scheduler] Запуск генерации поста...');

      const pending = await getPendingPost();
      if (pending) {
        console.log('[Scheduler] Пост уже ожидает согласования, генерация пропущена.');
        return;
      }

      try {
        const draft = await getCaseDraft();
        if (draft && draft.task && draft.solution && draft.result) {
          console.log('[Scheduler] Генерирую кейс из сохранённых данных...');
          const text = await generateCasePost(draft.task, draft.solution, draft.result);
          await clearCaseDraft();
          await sendForApproval(text, 'case');
        } else {
          const counter = await getFormatCounter();
          const format = (counter % 3) + 1;
          await incrementFormatCounter();
          console.log(`[Scheduler] Генерирую пост формата ${format} (${['', 'Норматив', 'Тренды', 'История'][format]})...`);
          const text = await generateFormatPost(format);
          await sendForApproval(text, `format_${format}`);
        }
      } catch (err) {
        console.error('[Scheduler] Ошибка генерации поста:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Генерация постов: каждый день в 10:00 МСК (Норматив→Тренды→История)');
}

/**
 * Каждый понедельник в 9:00 МСК — запрашиваем данные для кейса у менеджера.
 */
function scheduleCaseRequest() {
  cron.schedule(
    '0 9 * * 1',
    async () => {
      console.log('[Scheduler] Запрос данных для кейса у менеджера...');
      try {
        await startCaseCollection();
      } catch (err) {
        console.error('[Scheduler] Ошибка запроса кейса:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Запрос кейса: каждый понедельник в 9:00 МСК');
}

/**
 * Каждый понедельник в 9:00 МСК — обновление базы групп через tgstat.ru.
 */
function schedulePromoGroupsUpdate() {
  cron.schedule(
    '0 9 * * 1',
    async () => {
      console.log('[Scheduler] Обновление базы промо-групп через tgstat.ru...');
      try {
        await updatePromoGroups();
      } catch (err) {
        console.error('[Scheduler] Ошибка обновления базы групп:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Обновление базы промо-групп: каждый понедельник в 9:00 МСК');
}

/**
 * Каждый понедельник в 9:05 МСК — формирование очереди на неделю (14 групп, 30-дневный кулдаун).
 */
function scheduleBuildWeekQueue() {
  cron.schedule(
    '5 9 * * 1',
    async () => {
      console.log('[Scheduler] Формирование очереди на неделю...');
      try {
        await buildWeekQueue();
      } catch (err) {
        console.error('[Scheduler] Ошибка buildWeekQueue:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Очередь на неделю: каждый понедельник в 9:05 МСК');
}

/**
 * Каждый понедельник в 9:10 МСК — валидация очереди через Telegram API.
 */
function scheduleValidateWeekQueue(telegram) {
  cron.schedule(
    '10 9 * * 1',
    async () => {
      console.log('[Scheduler] Валидация очереди на неделю...');
      try {
        await validateWeekQueue(telegram);
      } catch (err) {
        console.error('[Scheduler] Ошибка validateWeekQueue:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Валидация очереди: каждый понедельник в 9:10 МСК');
}

/**
 * Каждый день в 9:20 МСК — берём следующую группу из очереди,
 * генерируем промо-пост и отправляем менеджеру на согласование.
 */
function scheduleDailyPromoApproval() {
  cron.schedule(
    '20 9 * * *',
    async () => {
      console.log('[Scheduler] Генерация ежедневного промо-поста...');
      try {
        const queue = await getWeekQueue();
        if (!queue.length) {
          console.log('[Scheduler] Очередь промо-групп пуста, пропускаем.');
          return;
        }

        const group = queue[0];
        const postText = await generatePromoPost(group);
        await sendDailyPromoForApproval(group, postText);
        console.log(`[Scheduler] Промо-пост для "${group.name}" отправлен менеджеру.`);
      } catch (err) {
        console.error('[Scheduler] Ошибка генерации промо-поста:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Ежедневный промо-пост на согласование: 9:20 МСК');
}

/**
 * Каждый понедельник в 9:00 МСК — обновление базы MAX сообществ через MAX API.
 */
function scheduleMaxPromoGroupsUpdate() {
  cron.schedule(
    '0 9 * * 1',
    async () => {
      console.log('[Scheduler] Обновление базы MAX промо-сообществ...');
      try {
        await updateMaxPromoGroups();
      } catch (err) {
        console.error('[Scheduler] Ошибка updateMaxPromoGroups:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Обновление базы MAX сообществ: каждый понедельник в 9:00 МСК');
}

/**
 * Каждый понедельник в 9:05 МСК — формирование MAX очереди на неделю.
 */
function scheduleMaxBuildWeekQueue() {
  cron.schedule(
    '5 9 * * 1',
    async () => {
      console.log('[Scheduler] Формирование MAX очереди на неделю...');
      try {
        await buildMaxWeekQueue();
      } catch (err) {
        console.error('[Scheduler] Ошибка buildMaxWeekQueue:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] MAX очередь на неделю: каждый понедельник в 9:05 МСК');
}

/**
 * Каждый день в 9:25 МСК — берём следующее MAX сообщество из очереди,
 * генерируем промо-пост и отправляем менеджеру на согласование.
 */
function scheduleMaxDailyPromoApproval() {
  cron.schedule(
    '25 9 * * *',
    async () => {
      console.log('[Scheduler] Генерация ежедневного MAX промо-поста...');
      try {
        const queue = await getMaxWeekQueue();
        if (!queue.length) {
          console.log('[Scheduler] MAX очередь пуста, пропускаем.');
          return;
        }
        const group = queue[0];
        const postText = await generateMaxPromoPost(group);
        await sendDailyMaxPromoForApproval(group, postText);
        console.log(`[Scheduler] MAX промо-пост для "${group.name}" отправлен менеджеру.`);
      } catch (err) {
        console.error('[Scheduler] Ошибка генерации MAX промо-поста:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Ежедневный MAX промо-пост на согласование: 9:25 МСК');
}

function startScheduler(telegram) {
  schedulePostGeneration();
  scheduleCaseRequest();

  // ПРОМО-АГЕНТ ОТКЛЮЧЁН (28.04.2026)
  // Холодные посты в чужих группах не эффективны для B2B.
  // Заменяем на таргетированную рекламу ВКонтакте.
  // schedulePromoGroupsUpdate();
  // scheduleBuildWeekQueue();
  // scheduleValidateWeekQueue(telegram);
  // scheduleDailyPromoApproval();
  // scheduleMaxPromoGroupsUpdate();
  // scheduleMaxBuildWeekQueue();
  // scheduleMaxDailyPromoApproval();
}

module.exports = { startScheduler };
