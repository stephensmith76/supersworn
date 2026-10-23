// Rules chat. Calls the provider straight from the browser with the player's own key.
import { store } from './store.js';

export const AI_PROVIDERS = {
  gemini: { label: 'Google Gemini', model: 'gemini-3.6-flash' },
  claude: { label: 'Anthropic Claude', model: 'claude-haiku-5-5' },
};

const SYSTEM = `You are the rules reference for a two-player game of Supersworn: Street Level, a hack of Ironsworn: Starforged about masked heroes in a corrupt city.
Answer rules questions from the rules text provided. When the hack changes a Starforged rule, the hack wins.
Name the moves and assets you rely on. Use the current game state when it matters (stats, momentum, Heat, enabled abilities, track progress).
Keep answers short: a direct answer first, then the reasoning in a sentence or two. Use plain language and no em dashes.
If the rules don't cover something, say so plainly and suggest Ask the Oracle or a quick table ruling. Don't invent rules.
You are not the game master: don't narrate the story or make choices for the players unless they ask for ideas.`;

function friendly(status, body) {
  if (status === 401 || status === 403) return 'The API key was refused. Check it in settings.';
  if (status === 429) return 'Rate limited by the provider. Wait a minute and try again.';
  if (status === 404) return 'That model was not found. Clear the Model box in settings to use the default.';
  return `The provider returned an error (${status}). ${String(body || '').slice(0, 200)}`;
}

export async function askRules(messages, ctx) {
  const provider = store.prefs.aiProvider || 'gemini';
  const key = store.prefs.aiKey;
  const model = store.prefs.aiModel || AI_PROVIDERS[provider].model;
  if (!key) throw new Error('Add an API key in settings first.');
  const history = messages.slice(-10);
  let res;
  try {
    if (provider === 'claude') {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model, max_tokens: 700,
          system: [
            { type: 'text', text: SYSTEM + '\n\n' + ctx.rules, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: ctx.state },
          ],
          messages: history.map(m => ({ role: m.role, content: m.text })),
        }),
      });
      if (!res.ok) throw new Error(friendly(res.status, await res.text()));
      const data = await res.json();
      return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || '(no answer)';
    }
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM + '\n\n' + ctx.rules + '\n\n' + ctx.state }] },
        contents: history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
        generationConfig: { maxOutputTokens: 1200, temperature: 0.3 },
      }),
    });
    if (!res.ok) throw new Error(friendly(res.status, await res.text()));
    const data = await res.json();
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    return parts.map(p => p.text || '').join('').trim() || '(no answer)';
  } catch (e) {
    if (e instanceof TypeError) throw new Error('Could not reach the provider. Check your connection.');
    throw e;
  }
}
