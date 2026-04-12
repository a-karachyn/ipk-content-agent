'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, casePostPrompt, newsPostPrompt } = require('./prompts');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-sonnet-4-5';

/**
 * Вызывает Claude с инструментом web_search и возвращает финальный текст.
 * Обрабатывает agentic loop: модель может сделать несколько поисков до ответа.
 */
async function callClaudeWithSearch(userPrompt) {
  const messages = [{ role: 'user', content: userPrompt }];

  for (let i = 0; i < 8; i++) {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      },
      { headers: { 'anthropic-beta': 'web-search-2025-03-05' } },
    );

    if (response.stop_reason === 'end_turn') {
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }

    // Продолжаем loop: добавляем ответ ассистента в историю
    messages.push({ role: 'assistant', content: response.content });

    // Для web_search результаты предоставляются сервером Anthropic автоматически,
    // но нам нужно подтвердить tool_use чтобы продолжить диалог
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // Нет tool_use — вернуть что есть
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }

    messages.push({
      role: 'user',
      content: toolUses.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: [],
      })),
    });
  }

  throw new Error('Превышен лимит итераций при генерации поста');
}

/**
 * Генерирует пост без web_search (для кейсов с готовыми данными).
 */
async function callClaudeSimple(userPrompt) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Генерирует пост-кейс по данным от менеджера.
 */
async function generateCasePost(task, solution, result) {
  const prompt = casePostPrompt(task, solution, result);
  return callClaudeSimple(prompt);
}

/**
 * Генерирует новостной/советный пост с поиском актуальных данных.
 */
async function generateNewsPost() {
  const prompt = newsPostPrompt();
  return callClaudeWithSearch(prompt);
}

module.exports = { generateCasePost, generateNewsPost };
