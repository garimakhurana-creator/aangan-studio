// Telegram is for Nikhil's operational alerts only (complaints, failures, SLA
// breaches). Designer handoff is email. Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.

const configured = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function alert(html) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram: ${data.description || res.status}`);
  return { message_id: data.result.message_id };
}

module.exports = { configured, alert, esc };
