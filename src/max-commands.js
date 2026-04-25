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
const {
  getAllGroups,
  getWeekQueue,
  markGroupUsed,
  removeFromWeekQueue,
  generateMaxPromoPost,
  getMaxPromoPending,
  setMaxPromoPending,
  clearMaxPromoPending,
  addGroup: addMaxPromoGroup,
  publishToMaxGroup,
} = require('./max-promo');

const MANAGER_ID = parseInt(process.env.MANAGER_CHAT_ID, 10);
const PAGE_SIZE = 10;

let _bot = null;

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

function maxPromoApprovalKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Опубликовать', 'max_promo_approve')],
    [Markup.button.callback('✏️ Редактировать', 'max_promo_edit')],
  ]);
}

function maxPromoDailyKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Одобрить', 'max_promo_daily_approve')],
    [
      Markup.button.callback('✏️ Редактировать', 'max_promo_daily_edit'),
      Markup.button.callback('❌ Пропустить',    'max_promo_daily_skip'),
    ],
  ]);
}

function pageKeyboard(page, total, prefix) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const buttons = [];
  if (page > 0) buttons.push(Markup.button.callback('◀️ Предыдущие 10', `${prefix}:${page - 1}`));
  if (page < totalPages - 1) buttons.push(Markup.button.callback('Следующие 10 ▶️', `${prefix}:${page + 1}`));
  return buttons.length ? Markup.inlineKeyboard([buttons]) : undefined;
}

function formatGroupsPage(groups, page) {
  const slice = groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return slice.map((g) => `• <b>${g.name.slice(0, 50)}</b>\n  ${g.link}`).join('\n');
}

// ─── Публикация промо с авто-фолбэком на ручную ──────────────────────────────

async function tryPublishAndNotify(pending) {
  const bot = _bot;
  const { text, group } = pending;
  try {
    await publishToMaxGroup(group, text);
    await markGroupUsed(group);
    await removeFromWeekQueue(group.chatId);
    await clearMaxPromoPending();
    await bot.telegram.sendMessage(
      MANAGER_ID,
      `✅ Пост опубликован в MAX: <b>${group.name}</b>\n${group.link}`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    if (err.message === 'no_chat_id') {
      await bot.telegram.sendMessage(
        MANAGER_ID,
        `⚠️ Бот не администратор «${group.name}». Скопируйте текст и опубликуйте вручную:\n\n${text}\n\n🔗 ${group.link}`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Опубликовано вручную', 'max_promo_manual_done')]]) },
      );
    } else {
      await bot.telegram.sendMessage(
        MANAGER_ID,
        `❌ Ошибка публикации в MAX (${err.message}). Скопируйте текст:\n\n${text}\n\n🔗 ${group.link}`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Опубликовано вручную', 'max_promo_manual_done')]]) },
      );
    }
  }
}

// ─── Отправка на согласование (ручная генерация) ─────────────────────────────

async function sendMaxForApproval(bot, postText, postType) {
  await setMaxPendingPost({ text: postText, type: postType });
  await bot.telegram.sendMessage(
    MANAGER_ID,
    `📝 <b>Новый пост для MAX канала (${postType === 'case' ? 'Кейс' : 'Новость/Совет'})</b>\n\n${postText}`,
    { parse_mode: 'HTML', ...maxApprovalKeyboard() },
  );
}

// ─── Ежедневный промо-пост менеджеру ─────────────────────────────────────────

async function sendDailyMaxPromoForApproval(group, postText) {
  if (!_bot) throw new Error('MAX bot не инициализирован — вызовите registerMaxHandlers первым');
  await setMaxPromoPending({ text: postText, group, source: 'daily' });
  await _bot.telegram.sendMessage(
    MANAGER_ID,
    `📣 <b>Ежедневный MAX промо-пост</b>\n<b>${group.name}</b>\n${group.link}\n\n${postText}`,
    { parse_mode: 'HTML', ...maxPromoDailyKeyboard() },
  );
}

// ─── Регистрация всех MAX обработчиков ───────────────────────────────────────

function registerMaxHandlers(bot) {
  _bot = bot;

  // ── Callbacks: согласование контент-поста ────────────────────────────────

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

  // ── Callbacks: промо-согласование (ручной /max_promo_post) ───────────────

  bot.action('max_promo_approve', async (ctx) => {
    await ctx.answerCbQuery();
    const pending = await getMaxPromoPending();
    if (!pending) return ctx.reply('Нет промо-поста MAX в очереди.');
    await ctx.editMessageReplyMarkup(undefined);
    await tryPublishAndNotify(pending);
  });

  bot.action('max_promo_edit', async (ctx) => {
    await ctx.answerCbQuery();
    await setMaxManagerState('editing_max_promo');
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply('✏️ Отправьте отредактированный текст промо-поста MAX.\n\n/max_cancel — отменить.');
  });

  // ── Callbacks: ежедневный промо-поток ────────────────────────────────────

  bot.action('max_promo_daily_approve', async (ctx) => {
    await ctx.answerCbQuery();
    const pending = await getMaxPromoPending();
    if (!pending) return ctx.reply('Нет промо-поста MAX в очереди.');
    await ctx.editMessageReplyMarkup(undefined);
    await tryPublishAndNotify(pending);
  });

  bot.action('max_promo_daily_edit', async (ctx) => {
    await ctx.answerCbQuery();
    await setMaxManagerState('editing_max_promo');
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply('✏️ Отправьте отредактированный текст промо-поста MAX.\n\n/max_cancel — отменить.');
  });

  bot.action('max_promo_daily_skip', async (ctx) => {
    await ctx.answerCbQuery();
    const pending = await getMaxPromoPending();
    const excludeChatId = pending?.group?.chatId || null;

    await clearMaxPromoPending();
    await ctx.editMessageReplyMarkup(undefined);

    const queue = await getWeekQueue();
    const nextGroup = queue.find((g) => g.chatId !== excludeChatId) || null;
    if (!nextGroup) {
      return ctx.reply('Больше нет сообществ в очереди на эту неделю. Новая очередь — в следующий понедельник.');
    }

    await ctx.reply(`Генерирую пост для следующего сообщества: <b>${nextGroup.name}</b>...`, { parse_mode: 'HTML' });
    try {
      const postText = await generateMaxPromoPost(nextGroup);
      await setMaxPromoPending({ text: postText, group: nextGroup, source: 'daily' });
      await ctx.replyWithHTML(
        `📣 <b>MAX промо-пост для ${nextGroup.name}</b>\n${nextGroup.link}\n\n${postText}`,
        maxPromoDailyKeyboard(),
      );
    } catch (err) {
      console.error('[MaxBot] max_promo_daily_skip error:', err);
      await ctx.reply('Ошибка при генерации поста: ' + err.message);
    }
  });

  bot.action('max_promo_manual_done', async (ctx) => {
    await ctx.answerCbQuery();
    const pending = await getMaxPromoPending();
    if (pending?.group) {
      await markGroupUsed(pending.group);
      await removeFromWeekQueue(pending.group.chatId);
    }
    await clearMaxPromoPending();
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply('✅ Зафиксировано как опубликованное вручную.');
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  bot.action(/^max_promo_list_page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1], 10);
    const groups = await getAllGroups();
    if (!groups.length) return ctx.reply('База сообществ MAX пуста.');

    const text =
      `📋 <b>Сообщества MAX (${groups.length})</b> — стр. ${page + 1}/${Math.ceil(groups.length / PAGE_SIZE)}\n\n` +
      formatGroupsPage(groups, page);
    const keyboard = pageKeyboard(page, groups.length, 'max_promo_list_page');
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  });

  // ── Команды: контент ──────────────────────────────────────────────────────

  bot.command('max_help', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    await ctx.replyWithHTML(
      `<b>Команды MAX Content Agent</b>\n\n` +
      `<b>Контент (MAX канал):</b>\n` +
      `/max_generate — сгенерировать пост для MAX канала\n` +
      `/max_case — запустить сбор данных для кейса\n` +
      `/max_status — состояние MAX агента\n\n` +
      `<b>Продвижение в MAX сообществах:</b>\n` +
      `/max_promo — статус системы продвижения MAX\n` +
      `/max_promo_list — список всех сообществ\n` +
      `/max_promo_post — промо-пост для следующего сообщества\n` +
      `/max_promo_add &lt;ссылка&gt; [название] — добавить сообщество вручную\n` +
      `/max_promo_stats — статистика охвата\n\n` +
      `/max_cancel — отменить текущую операцию\n` +
      `/max_help — этот список`,
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

  // ── Команды: продвижение ──────────────────────────────────────────────────

  bot.command('max_promo', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    try {
      const [all, queue] = await Promise.all([getAllGroups(), getWeekQueue()]);
      await ctx.replyWithHTML(
        `📊 <b>MAX Promo-система</b>\n\n` +
        `Всего сообществ в базе: ${all.length}\n` +
        `В очереди на неделю: ${queue.length}\n\n` +
        `/max_promo_list — список всех сообществ\n` +
        `/max_promo_post — сгенерировать промо-пост вручную\n` +
        `/max_promo_add &lt;ссылка&gt; — добавить сообщество\n` +
        `/max_promo_stats — статистика`,
      );
    } catch (err) {
      await ctx.reply('Ошибка: ' + err.message);
    }
  });

  bot.command('max_promo_list', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    const groups = await getAllGroups();
    if (!groups.length) {
      return ctx.reply('База сообществ MAX пуста. Поиск запускается каждый понедельник в 9:00.');
    }

    const page = 0;
    const text =
      `📋 <b>Сообщества MAX (${groups.length})</b>\n\n` +
      formatGroupsPage(groups, page);
    const keyboard = pageKeyboard(page, groups.length, 'max_promo_list_page');
    await ctx.replyWithHTML(text, keyboard);
  });

  bot.command('max_promo_post', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;

    const maxState = await getMaxManagerState();
    if (maxState !== 'idle') {
      return ctx.reply(`Сейчас активна MAX операция (${maxState}). Сначала /max_cancel.`);
    }

    const queue = await getWeekQueue();
    if (!queue.length) {
      return ctx.reply('Очередь на неделю пуста. Поиск и формирование очереди — каждый понедельник в 9:00–9:05.');
    }

    const group = queue[0];
    await ctx.reply(`Генерирую промо-пост для «<b>${group.name}</b>»...`, { parse_mode: 'HTML' });

    try {
      const postText = await generateMaxPromoPost(group);
      await setMaxPromoPending({ text: postText, group });
      await ctx.replyWithHTML(
        `📣 <b>MAX промо-пост для ${group.name}</b>\n${group.link}\n\n${postText}`,
        maxPromoApprovalKeyboard(),
      );
    } catch (err) {
      console.error('[MaxBot] /max_promo_post error:', err);
      await ctx.reply('Ошибка при генерации промо-поста: ' + err.message);
    }
  });

  bot.command('max_promo_add', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    const args = ctx.message.text.replace('/max_promo_add', '').trim().split(/\s+/);
    const link = args[0];
    const name = args.slice(1).join(' ') || undefined;
    if (!link) {
      return ctx.reply('Укажите ссылку: /max_promo_add max.ru/channel [Название]');
    }
    const added = await addMaxPromoGroup(name || link, link);
    await ctx.reply(added
      ? `✅ Сообщество добавлено: ${link}`
      : `Сообщество уже есть в базе: ${link}`,
    );
  });

  bot.command('max_promo_stats', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    try {
      const { getUsedGroups } = require('./max-promo');
      const [all, queue, used] = await Promise.all([getAllGroups(), getWeekQueue(), getUsedGroups()]);
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const recentUsed = used.filter((u) => new Date(u.usedAt).getTime() > thirtyDaysAgo);
      await ctx.replyWithHTML(
        `📈 <b>Статистика MAX продвижения</b>\n\n` +
        `Всего сообществ: ${all.length}\n` +
        `Очередь на неделю: ${queue.length}\n` +
        `Использовано за 30 дней: ${recentUsed.length}\n` +
        `Всего использовано: ${used.length}`,
      );
    } catch (err) {
      await ctx.reply('Ошибка: ' + err.message);
    }
  });
}

// ─── Обработчик текстовых сообщений для MAX state machine ────────────────────

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

  if (maxState === 'editing_max_promo') {
    const pending = await getMaxPromoPending();
    if (!pending) {
      await setMaxManagerState('idle');
      await ctx.reply('Нет MAX промо-поста для редактирования.');
      return true;
    }
    await setMaxPromoPending({ ...pending, text });
    await setMaxManagerState('idle');
    const keyboard = pending.source === 'daily'
      ? Markup.inlineKeyboard([
          [Markup.button.callback('✅ Одобрить', 'max_promo_daily_approve')],
          [Markup.button.callback('✏️ Редактировать', 'max_promo_daily_edit')],
        ])
      : Markup.inlineKeyboard([
          [Markup.button.callback('✅ Опубликовать', 'max_promo_approve')],
          [Markup.button.callback('✏️ Редактировать', 'max_promo_edit')],
        ]);
    await ctx.replyWithHTML(
      `📝 <b>Обновлённый MAX промо-пост для ${pending.group.name}</b>\n${pending.group.link}\n\n${text}`,
      keyboard,
    );
    return true;
  }

  return false;
}

module.exports = { registerMaxHandlers, handleMaxText, sendDailyMaxPromoForApproval };
