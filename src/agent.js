'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, casePostPrompt, newsPostPrompt, normativePostPrompt, trendPostPrompt, historyPostPrompt } = require('./prompts');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

async function callClaudeSimple(userPrompt) {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    const detail = err?.error?.message || err?.message || String(err);
    throw new Error(`Claude API error: ${detail}`);
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error(`Claude вернул пустой ответ (stop_reason: ${response.stop_reason})`);
  }

  return text;
}

async function generateCasePost(task, solution, result) {
  return callClaudeSimple(casePostPrompt(task, solution, result));
}

async function generateNewsPost() {
  return callClaudeSimple(newsPostPrompt());
}

async function generateFormatPost(format) {
  if (format === 1) return callClaudeSimple(normativePostPrompt());
  if (format === 2) return callClaudeSimple(trendPostPrompt());
  return callClaudeSimple(historyPostPrompt());
}

const FORMAT_LABELS = {
  1: 'Норматив',
  2: 'Тренды',
  3: 'История',
};

module.exports = { generateCasePost, generateNewsPost, generateFormatPost, FORMAT_LABELS, callClaudeSimple };
