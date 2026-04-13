'use strict';

/**
 * MAX Bot API client — используется ipk-content-agent для публикации
 * в MAX канал после одобрения менеджером.
 *
 * Auth: Authorization: Bearer <token>
 * Docs: https://dev.max.ru/docs
 */

const BASE_URL = 'https://botapi.max.ru';

function token() {
  const t = process.env.MAX_BOT_TOKEN;
  if (!t) throw new Error('MAX_BOT_TOKEN не задан');
  return t;
}

async function maxRequest(method, path, body = null) {
  const url = new URL(path, BASE_URL);

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url.toString(), opts);
  const json = await res.json();

  if (!res.ok) {
    const msg = json?.message || json?.description || JSON.stringify(json);
    throw new Error(`MAX API ${res.status}: ${msg}`);
  }

  return json;
}

async function publishToMaxChannel(text) {
  return maxRequest('POST', '/messages', {
    chat_id: process.env.MAX_CHANNEL_ID,
    text,
  });
}

module.exports = { publishToMaxChannel };
