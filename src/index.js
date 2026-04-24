'use strict';

require('dotenv').config();

const { bot } = require('./bot');
const { startScheduler } = require('./scheduler');
const { redis } = require('./redis');

async function main() {
  // Проверяем подключение к Redis
  await redis.ping();
  console.log('[App] Redis OK');

  // Запускаем планировщик
  startScheduler();

  // Сбрасываем webhook и активную polling-сессию перед стартом,
  // чтобы избежать 409 Conflict при редеплое на Render.
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('[App] Webhook сброшен, очередь обновлений очищена');
  } catch (err) {
    console.warn('[App] deleteWebhook failed (non-fatal):', err.message);
  }

  // Запускаем бота
  bot.launch({
    allowedUpdates: ['message', 'callback_query'],
  });

  console.log('[App] Бот запущен');

  // Graceful shutdown
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
