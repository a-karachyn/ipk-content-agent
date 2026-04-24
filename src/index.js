'use strict';

require('dotenv').config();

const { bot } = require('./bot');
const { startScheduler } = require('./scheduler');
const { redis } = require('./redis');

const LAUNCH_DELAY_MS = 3000;
const RETRY_409_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchBot() {
  console.log(`[App] Запуск бота через ${LAUNCH_DELAY_MS / 1000}с (ожидание завершения старого инстанса)...`);
  await sleep(LAUNCH_DELAY_MS);

  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('[App] Webhook сброшен');
  } catch (err) {
    console.warn('[App] deleteWebhook failed (non-fatal):', err.message);
  }

  bot.launch({ allowedUpdates: ['message', 'callback_query'] });
  console.log('[App] Бот запущен (polling)');
}

// Обрабатываем 409 Conflict — другой инстанс ещё держит polling.
// Ждём 5 секунд и перезапускаем polling.
bot.catch((err) => {
  const code = err?.response?.error_code;
  if (code === 409) {
    console.warn(`[Bot] 409 Conflict — другой инстанс polling. Перезапуск через ${RETRY_409_DELAY_MS / 1000}с...`);
    bot.stop();
    sleep(RETRY_409_DELAY_MS).then(() => {
      bot.launch({ allowedUpdates: ['message', 'callback_query'] });
      console.log('[Bot] Polling перезапущен после 409');
    });
  } else {
    console.error('[Bot] Необработанная ошибка:', err.message);
  }
});

async function main() {
  await redis.ping();
  console.log('[App] Redis OK');

  startScheduler();

  await launchBot();

  process.once('SIGINT', () => {
    console.log('[App] SIGINT — завершение...');
    bot.stop('SIGINT');
    redis.quit();
  });
  process.once('SIGTERM', () => {
    console.log('[App] SIGTERM — завершение...');
    bot.stop('SIGTERM');
    redis.quit();
  });
}

main().catch((err) => {
  console.error('[App] Критическая ошибка запуска:', err);
  process.exit(1);
});
