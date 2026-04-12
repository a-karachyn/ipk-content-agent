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
