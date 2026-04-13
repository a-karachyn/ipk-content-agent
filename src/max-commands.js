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
const {
  getGroups: getMaxPromoGroups,
  mergeGroups: mergeMaxPromoGroups,
  addGroup: addMaxPromoGroup,
  searchGroups: searchMaxPromoGroups,
  getPromoPending: getMaxPromoPending,
  setPromoPending: setMaxPromoPending,
  clearPromoPending: clearMaxPromoPending,
  pickNextGroup: pickNextMaxPromoGroup,
  generatePromoPost: generateMaxPromoPost,
  markGroupPublished: markMaxGroupPublished,
} = require('./max-promo');

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

function maxPromoApprovalKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Готово к публикации', 'max_promo_approve')],
    [
      Markup.button.callback('✏️ Редактировать', 'max_promo_edit'),
      Markup.button.callback('⏭️ Следующее сообщество', 'max_promo_next'),
    ],
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
      `<b>Продвижение в MAX сообществах:</b>\n` +
      `/max_promo — найти сообщества в MAX через MAX API\n` +
      `/max_promo_add — добавить найденное MAX сообщество в базу\n` +
      `/max_promo_post — сгенерировать промо-пост для следующего сообщества\n` +
      `/max_promo_list — список сообществ с датами публикаций\n\n` +
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

  // ── MAX Promo: поиск сообществ ────────────────────────────────────────────

  bot.command('max_promo', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    await ctx.reply('Ищу сообщества в MAX по 15 ключевым словам параллельно...');
    try {
      const found = await searchMaxPromoGroups();
      const { added, total } = await mergeMaxPromoGroups(found);
      const lines = found
        .slice(0, 20)
        .map((g) => `• <b>${g.name}</b>\n  ${g.link}`)
        .join('\n');
      const more = found.length > 20 ? `\n...и ещё ${found.length - 20}` : '';
      await ctx.replyWithHTML(
        `🔍 <b>Поиск завершён</b>\n\nНайдено: ${found.length}, добавлено новых: ${added}, всего в базе: ${total}\n\n${lines}${more}\n\nДля генерации промо-поста: /max_promo_post`,
      );
    } catch (err) {
      console.error('[MaxBot] /max_promo error:', err);
      await ctx.reply('Ошибка при поиске в MAX: ' + err.message);
    }
  });

  // ── MAX Promo: добавить сообщество вручную ────────────────────────────────

  bot.command('max_promo_add', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    await setMaxManagerState('adding_max_promo');
    await ctx.reply(
      '➕ Отправьте данные сообщества MAX в формате:\n\n' +
      '<code>Название\nmax.ru/ссылка\nКатегория (необязательно)</code>\n\n' +
      '/max_cancel — отменить',
      { parse_mode: 'HTML' },
    );
  });

  // ── MAX Promo: генерация поста ────────────────────────────────────────────

  bot.command('max_promo_post', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;

    const groups = await getMaxPromoGroups();
    if (!groups.length) {
      return ctx.reply('База сообществ MAX пуста. Сначала запустите /max_promo для поиска.');
    }

    const group = pickNextMaxPromoGroup(groups);
    if (!group) {
      return ctx.reply('Нет активных сообществ. Проверьте список через /max_promo_list.');
    }

    await ctx.reply(`Генерирую промо-пост для сообщества <b>${group.name}</b>...`, { parse_mode: 'HTML' });

    try {
      const postText = await generateMaxPromoPost(group);
      await setMaxPromoPending({ text: postText, group });
      await ctx.replyWithHTML(
        `📣 <b>Промо-пост для MAX: ${group.name}</b>\n${group.link}\n\n${postText}`,
        maxPromoApprovalKeyboard(),
      );
    } catch (err) {
      console.error('[MaxBot] /max_promo_post error:', err);
      await ctx.reply('Ошибка при генерации промо-поста: ' + err.message);
    }
  });

  // ── MAX Promo: список сообществ ───────────────────────────────────────────

  bot.command('max_promo_list', async (ctx) => {
    if (ctx.from.id !== MANAGER_ID) return;
    const groups = await getMaxPromoGroups();
    if (!groups.length) {
      return ctx.reply('База сообществ MAX пуста. Запустите /max_promo для поиска.');
    }

    const formatDate = (iso) => {
      if (!iso) return 'не публиковалось';
      const d = new Date(iso);
      return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    };

    const lines = groups.map((g, i) => {
      const status = g.status === 'active' ? '🟢' : '⏸️';
      return `${status} ${i + 1}. <b>${g.name}</b>\n   ${g.link}\n   <i>${g.topic}</i>\n   Последняя публикация: ${formatDate(g.lastPublished)}`;
    });

    await ctx.replyWithHTML(
      `📋 <b>Сообщества MAX для продвижения (${groups.length})</b>\n\n` + lines.join('\n\n'),
    );
  });

  // ── MAX Promo: callbacks ──────────────────────────────────────────────────

  bot.action('max_promo_approve', async (ctx) => {
    await ctx.answerCbQuery();
    const pending = await getMaxPromoPending();
    if (!pending) return ctx.reply('Нет промо-поста MAX в очереди.');

    await setMaxManagerState('confirming_max_promo_publish');
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply(
      `✅ После публикации напишите: в каком сообществе MAX опубликовали?\n(Название или ссылку)\n\n/max_cancel — отменить`,
    );
  });

  bot.action('max_promo_edit', async (ctx) => {
    await ctx.answerCbQuery();
    await setMaxManagerState('editing_max_promo');
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply('✏️ Отправьте отредактированный текст промо-поста MAX.\n\n/max_cancel — отменить.');
  });

  bot.action('max_promo_next', async (ctx) => {
    await ctx.answerCbQuery();
    const pending = await getMaxPromoPending();
    const excludeId = pending?.group?.id || null;

    const groups = await getMaxPromoGroups();
    const nextGroup = pickNextMaxPromoGroup(groups, excludeId);
    if (!nextGroup) {
      await clearMaxPromoPending();
      return ctx.reply('Больше нет активных сообществ MAX для выбора.');
    }

    await ctx.reply(`Генерирую пост для следующего сообщества: <b>${nextGroup.name}</b>...`, { parse_mode: 'HTML' });
    await ctx.editMessageReplyMarkup(undefined);

    try {
      const postText = await generateMaxPromoPost(nextGroup);
      await setMaxPromoPending({ text: postText, group: nextGroup });
      await ctx.replyWithHTML(
        `📣 <b>Промо-пост для MAX: ${nextGroup.name}</b>\n${nextGroup.link}\n\n${postText}`,
        maxPromoApprovalKeyboard(),
      );
    } catch (err) {
      console.error('[MaxBot] max_promo_next error:', err);
      await ctx.reply('Ошибка при генерации поста: ' + err.message);
    }
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

  if (maxState === 'adding_max_promo') {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      await ctx.reply('Нужно минимум 2 строки: название и ссылка. Попробуйте ещё раз или /max_cancel.');
      return true;
    }
    const [name, link, topic = ''] = lines;
    const result = await addMaxPromoGroup(name, link, topic);
    await setMaxManagerState('idle');
    if (!result.added) {
      await ctx.reply(`⚠️ Сообщество с этой ссылкой уже есть в базе. Всего: ${result.total}`);
    } else {
      await ctx.replyWithHTML(
        `✅ Добавлено: <b>${name}</b>\n${link}\nВсего в базе: ${result.total}\n\nДля генерации поста: /max_promo_post`,
      );
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
    await ctx.replyWithHTML(
      `📝 <b>Обновлённый промо-пост MAX</b>\n\n${text}`,
      maxPromoApprovalKeyboard(),
    );
    return true;
  }

  if (maxState === 'confirming_max_promo_publish') {
    const pending = await getMaxPromoPending();
    if (pending?.group) {
      await markMaxGroupPublished(pending.group.id, text);
    }
    await clearMaxPromoPending();
    await setMaxManagerState('idle');
    await ctx.reply(`✅ Отмечено как опубликованное в: ${text}`);
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
