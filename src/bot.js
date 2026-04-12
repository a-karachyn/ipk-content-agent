'use strict';

const { Telegraf, Markup } = require('telegraf');
const {
  getPendingPost,
  setPendingPost,
  clearPendingPost,
  getManagerState,
  setManagerState,
  setCaseField,
  getCaseDraft,
  clearCaseDraft,
} = require('./redis');
const { generateCasePost, generateNewsPost } = require('./agent');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const MANAGER_ID = parseInt(process.env.MANAGER_CHAT_ID, 10);
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// ─── Keyboard для согласования ────────────────────────────────────────────────

function approvalKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Опубликовать', 'post_approve'),
      Markup.button.callback('✏️ Редактировать', 'post_edit'),
    ],
    [Markup.button.callback('❌ Отклонить', 'post_reject')],
  ]);
}

// ─── Отправка поста на согласование ──────────────────────────────────────────

async function sendForApproval(postText, postType) {
  await setPendingPost({ text: postText, type: postType });

  await bot.telegram.sendMessage(
    MANAGER_ID,
    `📝 <b>Новый пост для канала (${postType === 'case' ? 'Кейс' : 'Новость/Совет'})</b>\n\n${postText}`,
    {
      parse_mode: 'HTML',
      ...approvalKeyboard(),
    },
  );
}

// ─── Публикация в канал ───────────────────────────────────────────────────────

async function publishToChannel(text) {
  await bot.telegram.sendMessage(CHANNEL_ID, text, { parse_mode: 'HTML' });
  await clearPendingPost();
  await setManagerState('idle');
}

// ─── Обработчики callback-кнопок ─────────────────────────────────────────────

bot.action('post_approve', async (ctx) => {
  await ctx.answerCbQuery();

  const post = await getPendingPost();
  if (!post) {
    return ctx.reply('Нет поста в очереди.');
  }

  await publishToChannel(post.text);
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply('✅ Опубликовано в канал!');
});

bot.action('post_edit', async (ctx) => {
  await ctx.answerCbQuery();
  await setManagerState('editing');
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply('✏️ Отправьте отредактированный текст поста.\n\n/cancel — отменить редактирование.');
});

bot.action('post_reject', async (ctx) => {
  await ctx.answerCbQuery();
  await clearPendingPost();
  await setManagerState('idle');
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply('❌ Пост отклонён и удалён из очереди.');
});

// ─── Команды ──────────────────────────────────────────────────────────────────

bot.command('help', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  await ctx.replyWithHTML(
    `<b>Команды IPK Content Agent</b>\n\n` +
    `/generate — принудительно сгенерировать пост и отправить на согласование\n` +
    `/case — запустить сбор данных для кейса вручную\n` +
    `/status — текущее состояние агента и очередь постов\n` +
    `/cancel — отменить текущую операцию (редактирование или сбор кейса)\n` +
    `/help — этот список\n\n` +
    `Посты генерируются автоматически каждые 2 дня в 10:00 МСК.\n` +
    `Запрос данных для кейса — каждый понедельник в 9:00 МСК.`,
  );
});

bot.command('generate', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;

  const pending = await getPendingPost();
  if (pending) {
    return ctx.reply('Уже есть пост на согласовании. Одобрите или отклоните его перед генерацией нового.');
  }

  await ctx.reply('Генерирую пост, подождите...');

  try {
    const { getPostCount, incrementPostCount } = require('./redis');
    const count = await getPostCount();
    const isCase = count % 2 === 0;
    await incrementPostCount();

    let postText;
    if (isCase) {
      const draft = await getCaseDraft();
      if (draft && draft.task && draft.solution && draft.result) {
        postText = await generateCasePost(draft.task, draft.solution, draft.result);
        await clearCaseDraft();
        await sendForApproval(postText, 'case');
      } else {
        postText = await generateNewsPost();
        await sendForApproval(postText, 'news');
      }
    } else {
      postText = await generateNewsPost();
      await sendForApproval(postText, 'news');
    }
  } catch (err) {
    console.error('[Bot] /generate error:', err);
    await ctx.reply('Ошибка при генерации поста: ' + err.message);
  }
});

bot.command('case', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;

  const state = await getManagerState();
  if (state !== 'idle') {
    return ctx.reply(`Сейчас выполняется другая операция (${state}). Сначала /cancel.`);
  }

  await startCaseCollection();
});

bot.command('cancel', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  await setManagerState('idle');
  await ctx.reply('Операция отменена.');
});

bot.command('status', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  const state = await getManagerState();
  const post = await getPendingPost();
  const draft = await getCaseDraft();

  let msg = `📊 <b>Статус агента</b>\n\nСостояние: <code>${state}</code>`;
  if (post) msg += `\n\nЕсть пост на согласовании (тип: ${post.type})`;
  if (draft && Object.keys(draft).length) msg += `\n\nЧерновик кейса: ${JSON.stringify(draft)}`;

  await ctx.replyWithHTML(msg);
});

// ─── Сбор данных для кейса (state machine) ────────────────────────────────────

async function startCaseCollection() {
  await clearCaseDraft();
  await setManagerState('collecting_task');
  await bot.telegram.sendMessage(
    MANAGER_ID,
    `📋 <b>Запрос данных для кейса</b>\n\nОпишите задачу заказчика — что было на входе, какая была проблема или цель?\n\n/cancel — пропустить на этот раз.`,
    { parse_mode: 'HTML' },
  );
}

// ─── Обработчик входящих сообщений от менеджера ───────────────────────────────

bot.on('text', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  if (ctx.message.text.startsWith('/')) return; // команды обрабатываются выше

  const state = await getManagerState();
  const text = ctx.message.text.trim();

  if (state === 'editing') {
    const currentPost = await getPendingPost();
    if (!currentPost) {
      await setManagerState('idle');
      return ctx.reply('Нет поста для редактирования.');
    }

    const updatedPost = { ...currentPost, text };
    await setPendingPost(updatedPost);
    await setManagerState('idle');

    await ctx.reply(
      `📝 <b>Обновлённый пост</b>\n\n${text}`,
      { parse_mode: 'HTML', ...approvalKeyboard() },
    );
    return;
  }

  if (state === 'collecting_task') {
    await setCaseField('task', text);
    await setManagerState('collecting_solution');
    return ctx.reply('Отлично. Теперь опишите решение — что сделали, какие системы запроектировали, почему именно так?');
  }

  if (state === 'collecting_solution') {
    await setCaseField('solution', text);
    await setManagerState('collecting_result');
    return ctx.reply('Последний шаг — результат. Что получил заказчик? Укажите конкретику: сроки, экономию, факты.');
  }

  if (state === 'collecting_result') {
    await setCaseField('result', text);
    await setManagerState('idle');

    await ctx.reply('Генерирую кейс, подождите...');

    try {
      const draft = await getCaseDraft();
      const postText = await generateCasePost(draft.task, draft.solution, text);
      await clearCaseDraft();
      await sendForApproval(postText, 'case');
    } catch (err) {
      console.error('[Bot] generateCasePost error:', err);
      await ctx.reply('Ошибка при генерации кейса. Данные сохранены, попробуйте /status.');
    }
    return;
  }

  // idle state — не ждём ничего конкретного
  await ctx.reply('Используйте кнопки одобрения или дождитесь очередного поста от агента.');
});

module.exports = { bot, sendForApproval, startCaseCollection };
