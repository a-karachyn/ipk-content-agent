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
const { generateCasePost, generateNewsPost, generateFormatPost, FORMAT_LABELS } = require('./agent');
const {
  getAllGroups,
  getWeekQueue,
  markGroupUsed,
  removeFromWeekQueue,
  buildWeekQueue,
  validateWeekQueue,
  generatePromoPost,
  getPromoPending,
  setPromoPending,
  clearPromoPending,
  getApprovedPromoPending,
  setApprovedPromoPending,
  clearApprovedPromoPending,
  addGroup,
  removeGroup,
} = require('./promo');

const { registerMaxHandlers, handleMaxText } = require('./max-commands');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const MANAGER_ID = parseInt(process.env.MANAGER_CHAT_ID, 10);
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// Регистрируем MAX команды и callbacks (max-content-agent не имеет polling)
registerMaxHandlers(bot);

// ─── Пагинация групп ──────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

function truncateName(name) {
  return name.length > 50 ? name.slice(0, 47) + '...' : name;
}

function formatGroupsPage(groups, page) {
  const start = page * PAGE_SIZE;
  const slice = groups.slice(start, start + PAGE_SIZE);
  return slice.map((g) => `• <b>${truncateName(g.name)}</b> — ${g.link}`).join('\n');
}

function pageKeyboard(page, total, callbackPrefix) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const buttons = [];
  if (page > 0) buttons.push(Markup.button.callback('◀️ Предыдущие 10', `${callbackPrefix}:${page - 1}`));
  if (page < totalPages - 1) buttons.push(Markup.button.callback('Следующие 10 ▶️', `${callbackPrefix}:${page + 1}`));
  return buttons.length ? Markup.inlineKeyboard([buttons]) : undefined;
}

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

// ─── Keyboard для промо-согласования ─────────────────────────────────────────

function promoApprovalKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Готово к публикации', 'promo_approve')],
    [
      Markup.button.callback('✏️ Редактировать', 'promo_edit'),
      Markup.button.callback('⏭️ Следующая группа', 'promo_next'),
    ],
  ]);
}

// ─── Keyboard для ежедневного промо-согласования ──────────────────────────────

function dailyPromoApprovalKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Одобрить', 'promo_daily_approve')],
    [
      Markup.button.callback('✏️ Редактировать', 'promo_daily_edit'),
      Markup.button.callback('⏭️ Пропустить канал', 'promo_daily_skip'),
    ],
  ]);
}

// ─── Keyboard после одобрения промо-поста ─────────────────────────────────────

function promoReadyKeyboard(group) {
  const raw = group?.link || '';
  const url = raw.startsWith('http') ? raw : `https://${raw}`;
  return Markup.inlineKeyboard([
    [Markup.button.callback('📋 Скопировать текст', 'copy_promo_text')],
    [Markup.button.url('🔗 Открыть группу', url)],
    [Markup.button.callback('✅ Опубликовано', 'promo_published')],
  ]);
}

// ─── Отправка поста на согласование ──────────────────────────────────────────

const POST_TYPE_LABELS = {
  case: 'Кейс',
  format_1: 'Норматив',
  format_2: 'Тренды',
  format_3: 'История',
  news: 'Новость/Совет',
};

async function sendForApproval(postText, postType) {
  await setPendingPost({ text: postText, type: postType });
  const label = POST_TYPE_LABELS[postType] || postType;

  await bot.telegram.sendMessage(
    MANAGER_ID,
    `📝 <b>Новый пост для канала (${label})</b>\n\n${postText}`,
    { parse_mode: 'HTML', ...approvalKeyboard() },
  );
}

// ─── Отправка ежедневного промо менеджеру на согласование ────────────────────

async function sendDailyPromoForApproval(group, postText) {
  await setPromoPending({ text: postText, group, source: 'daily' });
  await bot.telegram.sendMessage(
    MANAGER_ID,
    `📣 <b>Ежедневный промо-пост</b>\n<b>${group.name}</b>\n${group.link}\n\n${postText}`,
    { parse_mode: 'HTML', ...dailyPromoApprovalKeyboard() },
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
    `<b>Контент-канал:</b>\n` +
    `/generate — сгенерировать пост для @ipk_proekt\n` +
    `/case — запустить сбор данных для кейса\n` +
    `/status — состояние агента и очередь постов\n\n` +
    `<b>Продвижение:</b>\n` +
    `/promo — статус системы продвижения\n` +
    `/promo_post — сгенерировать промо-пост вручную\n` +
    `/promo_list — список всех групп в базе\n` +
    `/promo_add &lt;ссылка&gt; [название] — добавить группу\n` +
    `/promo_remove &lt;ссылка&gt; — удалить группу из базы\n` +
    `/promo_validate — проверить очередь на доступность\n` +
    `/promo_stats — статистика использования\n` +
    `/promo_build — принудительно пересобрать очередь и отправить промо на согласование\n\n` +
    `/cancel — отменить текущую операцию\n` +
    `/help — этот список\n\n` +
    `Посты: каждые 2 дня в 10:00 МСК. Запрос кейса: пн 9:00 МСК.`,
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
    const { getFormatCounter, incrementFormatCounter } = require('./redis');

    // Если есть готовый кейс — публикуем его приоритетно
    const draft = await getCaseDraft();
    if (draft && draft.task && draft.solution && draft.result) {
      const postText = await generateCasePost(draft.task, draft.solution, draft.result);
      await clearCaseDraft();
      await sendForApproval(postText, 'case');
    } else {
      // Чередуем три формата: 1-НОРМАТИВ, 2-ТРЕНДЫ, 3-ИСТОРИЯ
      const counter = await getFormatCounter();
      const format = (counter % 3) + 1;
      await incrementFormatCounter();
      const postText = await generateFormatPost(format);
      await sendForApproval(postText, `format_${format}`);
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

// ─── Команды продвижения ──────────────────────────────────────────────────────

bot.command('promo', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  try {
    const [all, queue] = await Promise.all([getAllGroups(), getWeekQueue()]);
    await ctx.replyWithHTML(
      `📊 <b>Прomo-система</b>\n\n` +
      `Всего групп в базе: ${all.length}\n` +
      `В очереди на неделю: ${queue.length}\n\n` +
      `/promo_list — список всех групп\n` +
      `/promo_post — сгенерировать промо-пост вручную\n` +
      `/promo_add &lt;ссылка&gt; — добавить группу\n` +
      `/promo_remove &lt;ссылка&gt; — удалить группу\n` +
      `/promo_validate — проверить очередь на доступность\n` +
      `/promo_stats — статистика`,
    );
  } catch (err) {
    console.error('[Bot] /promo error:', err);
    await ctx.reply('Ошибка: ' + err.message);
  }
});

bot.command('promo_post', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;

  const state = await getManagerState();
  if (state !== 'idle') {
    return ctx.reply(`Сейчас активна другая операция (${state}). Сначала /cancel.`);
  }

  const queue = await getWeekQueue();
  if (!queue.length) {
    return ctx.reply('Очередь на неделю пуста. Запустите buildWeekQueue (понедельник 9:05) или подождите.');
  }

  const group = queue[0];
  await ctx.reply(`Генерирую промо-пост для группы <b>${group.name}</b>...`, { parse_mode: 'HTML' });

  try {
    const postText = await generatePromoPost(group);
    await setPromoPending({ text: postText, group });
    await ctx.replyWithHTML(
      `📣 <b>Промо-пост для группы ${group.name}</b>\n${group.link}\n\n${postText}`,
      promoApprovalKeyboard(),
    );
  } catch (err) {
    console.error('[Bot] /promo_post error:', err);
    await ctx.reply('Ошибка при генерации промо-поста: ' + err.message);
  }
});

bot.command('promo_list', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  const groups = await getAllGroups();
  if (!groups.length) {
    return ctx.reply('База групп пуста. Группы автоматически загружаются из STATIC_GROUPS.');
  }

  const page = 0;
  const text =
    `📋 <b>База групп для продвижения (${groups.length})</b>\n\n` +
    formatGroupsPage(groups, page);
  const keyboard = pageKeyboard(page, groups.length, 'promo_list_page');
  await ctx.replyWithHTML(text, keyboard);
});

bot.action(/^promo_list_page:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const page = parseInt(ctx.match[1], 10);
  const groups = await getAllGroups();
  if (!groups.length) return ctx.reply('База групп пуста.');

  const text =
    `📋 <b>База групп (${groups.length})</b> — стр. ${page + 1}/${Math.ceil(groups.length / PAGE_SIZE)}\n\n` +
    formatGroupsPage(groups, page);
  const keyboard = pageKeyboard(page, groups.length, 'promo_list_page');
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
});

bot.command('promo_add', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  const args = ctx.message.text.replace('/promo_add', '').trim().split(/\s+/);
  const link = args[0];
  const name = args.slice(1).join(' ') || undefined;
  if (!link) {
    return ctx.reply('Укажите ссылку: /promo_add t.me/groupname [Название]');
  }
  const added = await addGroup(link, name);
  await ctx.reply(added ? `✅ Группа добавлена: ${link}` : `Группа уже есть в базе: ${link}`);
});

bot.command('promo_validate', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  const queue = await getWeekQueue();
  if (!queue.length) return ctx.reply('Очередь на неделю пуста.');

  await ctx.reply(`Проверяю ${queue.length} групп через Telegram API, подождите...`);
  try {
    const { removed, remaining } = await validateWeekQueue(bot.telegram);
    await ctx.reply(`✅ Удалено недоступных: ${removed}, в очереди осталось: ${remaining}`);
  } catch (err) {
    console.error('[Bot] /promo_validate error:', err);
    await ctx.reply('Ошибка при валидации: ' + err.message);
  }
});

bot.command('promo_stats', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  try {
    const { getUsedGroups } = require('./promo');
    const [all, queue, used] = await Promise.all([getAllGroups(), getWeekQueue(), getUsedGroups()]);
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentUsed = used.filter((u) => new Date(u.usedAt).getTime() > thirtyDaysAgo);
    await ctx.replyWithHTML(
      `📈 <b>Статистика продвижения</b>\n\n` +
      `Всего групп: ${all.length}\n` +
      `Очередь на неделю: ${queue.length}\n` +
      `Использовано за 30 дней: ${recentUsed.length}\n` +
      `Всего использовано: ${used.length}`,
    );
  } catch (err) {
    await ctx.reply('Ошибка: ' + err.message);
  }
});

bot.command('promo_remove', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  const arg = ctx.message.text.replace('/promo_remove', '').trim();
  if (!arg) {
    return ctx.reply('Укажите ссылку: /promo_remove t.me/groupname');
  }
  const deleted = await removeGroup(arg);
  if (deleted === 0) {
    return ctx.reply(`Группа не найдена в базе: ${arg}`);
  }
  await ctx.reply(`✅ Удалено групп: ${deleted} (совпадение по "${arg}")`);
});

bot.command('promo_build', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;

  await ctx.reply('🔄 Формирую очередь на неделю...');
  try {
    await buildWeekQueue();
  } catch (err) {
    console.error('[Bot] /promo_build buildWeekQueue error:', err);
    return ctx.reply('Ошибка при формировании очереди: ' + err.message);
  }

  const queue = await getWeekQueue();
  if (!queue.length) {
    return ctx.reply('Очередь пуста — все группы на кулдауне или база пустая.');
  }

  await ctx.reply(`✅ Очередь сформирована (${queue.length} групп). Генерирую промо-пост...`);

  try {
    const group = queue[0];
    const postText = await generatePromoPost(group);
    await sendDailyPromoForApproval(group, postText);
  } catch (err) {
    console.error('[Bot] /promo_build sendDailyPromoForApproval error:', err);
    await ctx.reply('Очередь готова, но ошибка при генерации промо-поста: ' + err.message);
  }
});

// ─── Callbacks: промо-согласование ────────────────────────────────────────────

bot.action('promo_approve', async (ctx) => {
  await ctx.answerCbQuery();
  const pending = await getPromoPending();
  if (!pending) return ctx.reply('Нет промо-поста в очереди.');

  await setApprovedPromoPending(pending);
  await clearPromoPending();
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.replyWithHTML(
    `✅ <b>Промо-пост одобрен!</b>\n<b>${pending.group.name}</b> | ${pending.group.link}\n\n${pending.text}`,
    promoReadyKeyboard(pending.group),
  );
});

bot.action('promo_edit', async (ctx) => {
  await ctx.answerCbQuery();
  await setManagerState('editing_promo');
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply('✏️ Отправьте отредактированный текст промо-поста.\n\n/cancel — отменить.');
});

bot.action('promo_next', async (ctx) => {
  await ctx.answerCbQuery();
  const pending = await getPromoPending();
  const excludeLink = pending?.group?.link || null;

  const queue = await getWeekQueue();
  const nextGroup = queue.find((g) => g.link !== excludeLink) || null;
  if (!nextGroup) {
    await clearPromoPending();
    return ctx.reply('Больше нет групп в очереди на эту неделю.');
  }

  await ctx.reply(`Генерирую пост для следующей группы: <b>${nextGroup.name}</b>...`, { parse_mode: 'HTML' });
  await ctx.editMessageReplyMarkup(undefined);

  try {
    const postText = await generatePromoPost(nextGroup);
    await setPromoPending({ text: postText, group: nextGroup });
    await ctx.replyWithHTML(
      `📣 <b>Промо-пост для группы ${nextGroup.name}</b>\n${nextGroup.link}\n\n${postText}`,
      promoApprovalKeyboard(),
    );
  } catch (err) {
    console.error('[Bot] promo_next error:', err);
    await ctx.reply('Ошибка при генерации поста: ' + err.message);
  }
});

// ─── Callbacks: ежедневное промо-согласование ─────────────────────────────────

bot.action('promo_daily_approve', async (ctx) => {
  await ctx.answerCbQuery();
  const pending = await getPromoPending();
  if (!pending) return ctx.reply('Нет промо-поста в очереди.');

  await setApprovedPromoPending(pending);
  await clearPromoPending();
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.replyWithHTML(
    `✅ <b>Промо-пост одобрен!</b>\n<b>${pending.group.name}</b> | ${pending.group.link}\n\n${pending.text}`,
    promoReadyKeyboard(pending.group),
  );
});

bot.action('promo_daily_edit', async (ctx) => {
  await ctx.answerCbQuery();
  await setManagerState('editing_promo');
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply('✏️ Отправьте отредактированный текст промо-поста.\n\n/cancel — отменить.');
});

bot.action('promo_daily_skip', async (ctx) => {
  await ctx.answerCbQuery();
  const pending = await getPromoPending();
  const excludeLink = pending?.group?.link || null;

  await clearPromoPending();
  await ctx.editMessageReplyMarkup(undefined);

  const queue = await getWeekQueue();
  const nextGroup = queue.find((g) => g.link !== excludeLink) || null;
  if (!nextGroup) {
    return ctx.reply('Больше нет групп в очереди на эту неделю. Новая очередь — в следующий понедельник.');
  }

  await ctx.reply(`Генерирую пост для следующей группы: <b>${nextGroup.name}</b>...`, { parse_mode: 'HTML' });
  try {
    const postText = await generatePromoPost(nextGroup);
    await setPromoPending({ text: postText, group: nextGroup, source: 'daily' });
    await ctx.replyWithHTML(
      `📣 <b>Промо-пост для канала ${nextGroup.name}</b>\n${nextGroup.link}\n\n${postText}`,
      dailyPromoApprovalKeyboard(),
    );
  } catch (err) {
    console.error('[Bot] promo_daily_skip error:', err);
    await ctx.reply('Ошибка при генерации поста: ' + err.message);
  }
});

// ─── Callbacks: копирование и фиксация публикации ────────────────────────────

bot.action('copy_promo_text', async (ctx) => {
  await ctx.answerCbQuery();
  const approved = await getApprovedPromoPending();
  if (!approved) return ctx.reply('Пост не найден — возможно уже опубликован.');
  await ctx.reply(approved.text);
  await ctx.reply('Скопируйте текст выше, откройте группу и вставьте. Когда опубликуете — нажмите ✅ Опубликовано.');
});

bot.action('promo_published', async (ctx) => {
  await ctx.answerCbQuery();
  const approved = await getApprovedPromoPending();
  if (!approved) return ctx.reply('Данные о посте не найдены.');

  await markGroupUsed(approved.group);
  await removeFromWeekQueue(approved.group.link);
  await clearApprovedPromoPending();
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply(`✅ Зафиксировано! Группа "${approved.group.name}" — следующая публикация через 30 дней.`);
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

  // MAX state machine — если MAX-состояние активно, обрабатываем там
  const maxHandled = await handleMaxText(ctx, bot);
  if (maxHandled) return;

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
      await ctx.reply(`Ошибка при генерации кейса: ${err.message}\n\nДанные сохранены, попробуйте /generate позже.`);
    }
    return;
  }

  if (state === 'editing_promo') {
    const pending = await getPromoPending();
    if (!pending) {
      await setManagerState('idle');
      return ctx.reply('Нет промо-поста для редактирования.');
    }
    await setPromoPending({ ...pending, text });
    await setManagerState('idle');
    await ctx.replyWithHTML(
      `📣 <b>Обновлённый промо-пост для ${pending.group.name}</b>\n${pending.group.link}\n\n${text}`,
      promoApprovalKeyboard(),
    );
    return;
  }

  // idle state — не ждём ничего конкретного
  await ctx.reply('Используйте кнопки одобрения или дождитесь очередного поста от агента.');
});

module.exports = { bot, sendForApproval, startCaseCollection, sendDailyPromoForApproval };
