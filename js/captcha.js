// Cloudflare Turnstile: proves a contributor's phone is a person, once per phone.
// Usually invisible; occasionally shows a one-tap check.
import { TURNSTILE_SITE_KEY } from './config.js?v=12';
import { loadScript } from './util.js?v=12';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export async function captchaToken(timeoutMs = 90000) {
  if (!TURNSTILE_SITE_KEY) return null;
  await loadScript(SCRIPT);
  const box = document.createElement('div');
  box.className = 'captcha-box';
  box.innerHTML = '<p class="small">Quick check that you\'re a person (once per phone):</p><div></div>';
  document.body.appendChild(box);
  let widgetId;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The "are you a person" check timed out. Tap Retry in the upload panel.')), timeoutMs);
      widgetId = window.turnstile.render(box.lastElementChild, {
        sitekey: TURNSTILE_SITE_KEY,
        appearance: 'interaction-only',
        callback: token => { clearTimeout(timer); resolve(token); },
        'error-callback': () => { clearTimeout(timer); reject(new Error('The "are you a person" check failed. Check your connection and retry.')); },
        'before-interactive-callback': () => box.classList.add('show'),
      });
    });
  } finally {
    try { if (widgetId != null) window.turnstile.remove(widgetId); } catch (e) { /* ignore */ }
    box.remove();
  }
}
