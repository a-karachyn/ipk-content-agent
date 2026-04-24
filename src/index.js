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
  console.log(`[App] Запуск бота через ${LAUNCH_DELAY_MS / 1000}с...`);
  await sleep(LAUNCH_DELAY_MS);

  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('[App] Webhook сброшен');
  } catch (err) {
    console.warn('[App] deleteWebhook failed (non-fatal):', err.message);
  }

  // bot.launch() возвращает Promise, который resolves при bot.stop() и rejects
  // при неустранимой ошибке (401, 409 и т.д.). Без .catch() — unhandled rejection
  // → Node.js 15+ падает с exit code 1.
  bot
    .launch({ allowedUpdates: ['message', 'callback_query'] })
    .catch((err) => {
      const code = err?.response?.error_code;
      if (code === 409) {
        console.warn(`[Bot] 409 Conflict — другой инстанс polling. Перезапуск через ${RETRY_409_DELAY_MS / 1000}с...`);
        sleep(RETRY_409_DELAY_MS).then(() => launchBot());
      } else {
        console.error('[Bot] Ошибка polling (планировщик продолжает работу):', err.message);
      }
    });

  console.log('[App] Бот запущен (polling)');
}

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
