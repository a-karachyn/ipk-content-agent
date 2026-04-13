'use strict';

/**
 * Обработчики Telegram-команд и callback-кнопок для MAX контент-агента.
 *
 * MAX-агент (ipk-max-content-agent) НЕ запускает Telegram polling —
 * он только сохраняет посты в Redis (max_content:) и шлёт HTTP-уведомления.
 * Этот модуль регистрирует обработчики в существующем Telegraf-боте
 * ipk-content-agent, который уже ведёт polling.
 */

const { Markup } = require('telegraf');
const { publishToMaxChannel } = require('./max');
const {
  getMaxPendingPost,
  setMaxPendingPost,
  clearMaxPendingPost,
  getMaxManagerState,
  setMaxManagerState,
  setMaxCaseField,
  getMaxCaseDraft,
  clearMaxCaseDraft,
} = require('./redis');
const { generateCasePost, generateNewsPost } = require('./agent');
const { getPostCount, incrementPostCount, getCaseDraft } = require('./redis');

const MANAGER_ID = parseInt(process.env.MANAGER_CHAT_ID, 10);

// ─── Keyboards ────────────────────────────────────────────────────────────────

function maxApprovalKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Опубликовать в MAX', 'max_post_approve'),
      Markup.button.callback('✏️ Редактировать',      'max_post_edit'),
    ],
    [Markup.button.callback('❌ Отклонить', 'max_post_reject')],
  ]);
}

// ─── Отправка на согласование (используется при ручной генерации) ─────────────

async function sendMaxForApproval(bot, postText, postType) {
  await setMaxPendingPost({ text: postText, type: postType });
  await bot.telegram.sendMessage(
    MANAGER_ID,
    `📝 <b>Новый пост для MAX канала (${postType === 'case' ? 'Кейс' : 'Новость/Совет'})</b>\n\n${postText}`,
    { parse_mode: 'HTML', ...maxApprovalKeyboard() },
  );
}

// ─── Регистрация всех MAX обработчиков ───────────────────────────────────────

function registerMaxHandlers(bot) {

  // ── Callbacks: согласование поста ────────────────────────────────────────

  bot.action('max_post_approve', async (ctx) => {
    await ctx.answerCbQuery();
    const post = await getMaxPendingPost();
    if (!post) return ctx.reply('Нет MAX поста в очереди.');

    try {
      await publishToMaxChannel(post.text);
      await clearMaxPendingPost();
      await setMaxManagerState('idle');
      await ctx.editMessageReplyMarkup(undefined);
      await ctx.reply('✅ Пост опубликован в MAX канал!');
    } catch (err) {
      console.error('[MaxBot] publish error:', err);
      await ctx.reply(`Ошибка публикации в MAX: ${err.message}`);
    }
  });

  bot.action('max_post_edit', async (ctx) => {
    await ctx.answerCbQuery();
    await setMaxManagerState('max_editing');
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply('✏️ Отправьте отредактированный текст MAX поста.\n\n/max_cancel — отменить.');
  });

  bot.action('max_post_reject', async (ctx) => {
    await ctx.answerCbQuery();
    await clearMaxPendingPost();
    await setMaxManagerState('idle');
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply('❌ MAX пост отклонён.');
  });

  // ── Команды ──────────────────────────────────────────────────────────────

  bot.command('max_help', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    await ctx.replyWithHTML(
      `<b>Команды MAX Content Agent</b>\n\n` +
      `<b>Контент (MAX канал):</b>\n` +
      `/max_generate — сгенерировать пост для MAX канала\n` +
      `/max_case — запустить сбор данных для кейса\n` +
      `/max_status — состояние MAX агента\n\n` +
      `/max_cancel — отменить текущую операцию\n` +
      `/max_help — этот список\n\n` +
      `Посты: каждые 2 дня в 10:00 МСК (автоматически через max-content-agent).\n` +
      `Запрос кейса: пн 9:00 МСК.`,
    );
  });

  bot.command('max_generate', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;

    const pending = await getMaxPendingPost();
    if (pending) {
      return ctx.reply('Уже есть MAX пост на согласовании. Одобрите или отклоните его перед генерацией нового.');
    }

    await ctx.reply('Генерирую пост для MAX, подождите...');

    try {
      // Используем счётчик max_content: (из max-content-agent)
      const { redis } = require('./redis');
      const rawCount = await redis.get('max_content:post_count');
      const count = parseInt(rawCount || '0', 10);
      const isCase = count % 2 === 0;
      await redis.incr('max_content:post_count');

      let postText;
      if (isCase) {
        const draft = await getMaxCaseDraft();
        if (draft && draft.task && draft.solution && draft.result) {
          postText = await generateCasePost(draft.task, draft.solution, draft.result);
          await clearMaxCaseDraft();
        } else {
          postText = await generateNewsPost();
        }
      } else {
        postText = await generateNewsPost();
      }

      await sendMaxForApproval(bot, postText, isCase ? 'case' : 'news');
    } catch (err) {
      console.error('[MaxBot] /max_generate error:', err);
      await ctx.reply(`Ошибка при генерации MAX поста: ${err.message}`);
    }
  });

  bot.command('max_case', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    const maxState = await getMaxManagerState();
    if (maxState !== 'idle') {
      return ctx.reply(`Сейчас активна MAX операция (${maxState}). Сначала /max_cancel.`);
    }
    await clearMaxCaseDraft();
    await setMaxManagerState('max_collecting_task');
    await ctx.replyWithHTML(
      `📋 <b>Данные для MAX кейса</b>\n\nОпишите задачу заказчика — что было на входе, какая была проблема или цель?\n\n/max_cancel — отменить.`,
    );
  });

  bot.command('max_status', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    const maxState = await getMaxManagerState();
    const post = await getMaxPendingPost();
    const draft = await getMaxCaseDraft();

    let msg = `📊 <b>Статус MAX агента</b>\n\nСостояние: <code>${maxState}</code>`;
    if (post) msg += `\n\nЕсть MAX пост на согласовании (тип: ${post.type})`;
    if (draft && Object.keys(draft).length) msg += `\n\nЧерновик MAX кейса: ${JSON.stringify(draft)}`;

    await ctx.replyWithHTML(msg);
  });

  bot.command('max_cancel', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    await setMaxManagerState('idle');
    await ctx.reply('MAX операция отменена.');
  });
}

// ─── Обработчик текстовых сообщений для MAX state machine ────────────────────
// Вызывается из bot.on('text') в bot.js ПЕРЕД обработкой Telegram-состояний.
// Возвращает true, если сообщение было обработано.

async function handleMaxText(ctx, bot) {
  if (ctx.from.id !== MANAGER_ID) return false;

  const maxState = await getMaxManagerState();
  if (maxState === 'idle') return false;

  const text = ctx.message.text.trim();

  if (maxState === 'max_editing') {
    const post = await getMaxPendingPost();
    if (!post) {
      await setMaxManagerState('idle');
      await ctx.reply('Нет MAX поста для редактирования.');
      return true;
    }
    await setMaxPendingPost({ ...post, text });
    await setMaxManagerState('idle');
    await ctx.replyWithHTML(
      `📝 <b>Обновлённый MAX пост</b>\n\n${text}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Опубликовать в MAX', 'max_post_approve'),
          Markup.button.callback('✏️ Редактировать',      'max_post_edit'),
        ],
        [Markup.button.callback('❌ Отклонить', 'max_post_reject')],
      ]),
    );
    return true;
  }

  if (maxState === 'max_collecting_task') {
    await setMaxCaseField('task', text);
    await setMaxManagerState('max_collecting_solution');
    await ctx.reply('Отлично. Теперь опишите решение — что сделали, какие системы запроектировали, почему именно так?');
    return true;
  }

  if (maxState === 'max_collecting_solution') {
    await setMaxCaseField('solution', text);
    await setMaxManagerState('max_collecting_result');
    await ctx.reply('Последний шаг — результат. Что получил заказчик? Укажите конкретику: сроки, экономию, факты.');
    return true;
  }

  if (maxState === 'max_collecting_result') {
    await setMaxCaseField('result', text);
    await setMaxManagerState('idle');
    await ctx.reply('Генерирую MAX кейс, подождите...');
    try {
      const draft = await getMaxCaseDraft();
      const postText = await generateCasePost(draft.task, draft.solution, text);
      await clearMaxCaseDraft();
      await sendMaxForApproval(bot, postText, 'case');
    } catch (err) {
      console.error('[MaxBot] generateCasePost error:', err);
      await ctx.reply(`Ошибка при генерации MAX кейса: ${err.message}\n\nДанные сохранены, попробуйте /max_generate позже.`);
    }
    return true;
  }

  return false;
}

module.exports = { registerMaxHandlers, handleMaxText };
