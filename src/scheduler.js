'use strict';

const cron = require('node-cron');
const { getFormatCounter, incrementFormatCounter, getPendingPost, getCaseDraft, clearCaseDraft } = require('./redis');
const { generateCasePost, generateFormatPost } = require('./agent');
const { sendForApproval, startCaseCollection, sendDailyPromoMessage, sendApprovedPromoText } = require('./bot');
const { updatePromoGroups, getGroups, pickNextGroup, generatePromoPost } = require('./promo');

/**
 * Каждые 2 дня в 10:00 по Москве генерируем пост.
 * Если есть данные кейса — публикуем кейс.
 * Иначе чередуем три формата: 1-НОРМАТИВ → 2-ТРЕНДЫ → 3-ИСТОРИЯ → 1...
 */
function schedulePostGeneration() {
  cron.schedule(
    '0 10 */2 * *',
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

  console.log('[Scheduler] Генерация постов: каждые 2 дня в 10:00 МСК (Норматив→Тренды→История)');
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
 * Каждый понедельник в 9:00 МСК — автоматическое обновление списка профильных каналов.
 * Параллельный поиск по 10 категориям через Promise.all, результат в Redis promo:groups.
 */
function schedulePromoGroupsUpdate() {
  cron.schedule(
    '0 9 * * 1',
    async () => {
      console.log('[Scheduler] Обновление базы промо-групп...');
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
 * Каждый день в 9:20 МСК — берём следующую группу из списка,
 * генерируем промо-пост и отправляем менеджеру на согласование.
 */
function scheduleDailyPromoApproval() {
  cron.schedule(
    '20 9 * * *',
    async () => {
      console.log('[Scheduler] Генерация ежедневного промо-поста...');
      try {
        const groups = await getGroups();
        if (!groups.length) {
          console.log('[Scheduler] База промо-групп пуста, пропускаем.');
          return;
        }

        const group = pickNextGroup(groups);
        if (!group) {
          console.log('[Scheduler] Нет активных групп для промо.');
          return;
        }

        const postText = await generatePromoPost(group);
        await sendDailyPromoMessage(group, postText);
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
 * В 11:00 и 20:00 МСК — отправляем менеджеру одобренный промо-текст для копирования и ручной публикации.
 */
function scheduleApprovedPromoPublish() {
  cron.schedule(
    '0 11 * * *',
    async () => {
      console.log('[Scheduler] Публикация одобренного промо (11:00)...');
      try {
        await sendApprovedPromoText();
      } catch (err) {
        console.error('[Scheduler] Ошибка публикации промо 11:00:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  cron.schedule(
    '0 20 * * *',
    async () => {
      console.log('[Scheduler] Публикация одобренного промо (20:00)...');
      try {
        await sendApprovedPromoText();
      } catch (err) {
        console.error('[Scheduler] Ошибка публикации промо 20:00:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Публикация одобренного промо: 11:00 и 20:00 МСК');
}

function startScheduler() {
  schedulePostGeneration();
  scheduleCaseRequest();
  schedulePromoGroupsUpdate();
  scheduleDailyPromoApproval();
  scheduleApprovedPromoPublish();
}

module.exports = { startScheduler };
