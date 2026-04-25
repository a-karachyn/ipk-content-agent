'use strict';

const SYSTEM_PROMPT = `Ты — контент-редактор ИПК (СПб). Компания проектирует СПС, СОУЭ, пожаротушение, СКУД. Канал @ipk_proekt. Пиши коротко, конкретно, профессионально. Без канцелярита. Проверяй грамматику — никаких ошибок в падежах.`;

const POST_SUFFIX = `В конце поста добавь: "Подписывайтесь на канал ИПК: t.me/ipk_proekt"
Затем 2–3 хэштега: #пожарнаябезопасность #проектирование #ИПК (добавь тематический если уместно).`;

function casePostPrompt(task, solution, result) {
  return `Напиши пост-кейс 150 слов для @ipk_proekt.
🔹 Задача: ${task}
🔧 Решение: ${solution}
✅ Результат: ${result}
Добавь одно предложение — вывод для проектировщиков. Только готовый пост, без преамбул.
${POST_SUFFIX}`;
}

function newsPostPrompt() {
  return `Напиши пост 150 слов о практическом нюансе проектирования систем пожарной безопасности (СПС, СОУЭ, пожаротушение). ИПК СПб. Конкретно, без воды.
${POST_SUFFIX}`;
}

function normativePostPrompt() {
  return `Напиши пост 150 слов о новом нормативе пожарной безопасности РФ. Практичный стиль. ИПК СПб — проектирование СПС, СОУЭ, пожаротушение, СКУД.
${POST_SUFFIX}`;
}

function trendPostPrompt() {
  return `Напиши пост 150 слов о современных технологиях в инженерном проектировании (BIM, AI). ИПК СПб.
${POST_SUFFIX}`;
}

function historyPostPrompt() {
  return `Напиши пост 150 слов об историческом факте из истории пожарной безопасности или проектирования.
${POST_SUFFIX}`;
}

module.exports = { SYSTEM_PROMPT, casePostPrompt, newsPostPrompt, normativePostPrompt, trendPostPrompt, historyPostPrompt };
