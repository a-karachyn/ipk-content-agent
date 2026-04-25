'use strict';

const SYSTEM_PROMPT = `Ты — контент-редактор ИПК (СПб). Компания проектирует СПС, СОУЭ, пожаротушение, СКУД. Канал @ipk_proekt. Пиши коротко, конкретно, профессионально. Без канцелярита. 3–5 хэштегов в конце.`;

function casePostPrompt(task, solution, result) {
  return `Напиши пост-кейс 150 слов для @ipk_proekt.
🔹 Задача: ${task}
🔧 Решение: ${solution}
✅ Результат: ${result}
Добавь одно предложение — вывод для проектировщиков. Только готовый пост, без преамбул.`;
}

function newsPostPrompt() {
  return `Напиши пост 150 слов о практическом нюансе проектирования систем пожарной безопасности (СПС, СОУЭ, пожаротушение). ИПК СПб. Конкретно, без воды.`;
}

function normativePostPrompt() {
  return `Напиши пост 150 слов о новом нормативе пожарной безопасности РФ. Практичный стиль. ИПК СПб — проектирование СПС, СОУЭ, пожаротушение, СКУД.`;
}

function trendPostPrompt() {
  return `Напиши пост 150 слов о современных технологиях в инженерном проектировании (BIM, AI). ИПК СПб.`;
}

function historyPostPrompt() {
  return `Напиши пост 150 слов об историческом факте из истории пожарной безопасности или проектирования.`;
}

module.exports = { SYSTEM_PROMPT, casePostPrompt, newsPostPrompt, normativePostPrompt, trendPostPrompt, historyPostPrompt };
