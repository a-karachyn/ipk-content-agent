'use strict';

require('dotenv').config();

const express = require('express');
const { bot } = require('./bot');
const { startScheduler } = require('./scheduler');
const { redis } = require('./redis');

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = 'https://ipk-content-agent.onrender.com/webhook';

async function main() {
  await redis.ping();
  console.log('[App] Redis OK');

  startScheduler(bot.telegram);

  // Webhook mode — без polling, без 409 Conflict
  await bot.telegram.setWebhook(WEBHOOK_URL, {
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  console.log(`[App] Webhook установлен: ${WEBHOOK_URL}`);

  const app = express();
  app.use(express.json());

  app.post('/webhook', (req, res) => {
    bot.handleUpdate(req.body, res).catch((err) => {
      console.error('[Webhook] handleUpdate error:', err.message);
      if (!res.headersSent) res.sendStatus(500);
    });
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.listen(PORT, () => {
    console.log(`[App] Express слушает порт ${PORT}`);
    console.log('[App] IPK Content Agent запущен (webhook mode)');
  });

  process.once('SIGINT', () => {
    console.log('[App] SIGINT — завершение...');
    redis.quit();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    console.log('[App] SIGTERM — завершение...');
    redis.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[App] Критическая ошибка запуска:', err);
  process.exit(1);
});
