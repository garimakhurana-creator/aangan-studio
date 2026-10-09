// Email via Resend (RESEND_API_KEY). Test mode: EMAIL_OVERRIDE_TO sends every
// email there instead, with a banner saying who it was meant for.

const configured = () => Boolean(process.env.RESEND_API_KEY);
const overrideTo = () => (process.env.EMAIL_OVERRIDE_TO || '').trim();

async function sendEmail({ to, subject, html, text, idempotencyKey }) {
  if (!to) throw new Error('No recipient address.');
  const testTo = overrideTo();
  const banner = testTo ? `[Test mode: this email would have gone to ${to}]` : '';
  const body = {
    from: process.env.RESEND_FROM || 'Aangan Studio <onboarding@resend.dev>',
    to: [testTo || to],
    subject,
    html: banner ? `<p style="background:#fff3cd;padding:8px;font:13px sans-serif">${banner}</p>${html}` : html,
    text: banner ? `${banner}\n\n${text}` : text,
  };
  if (process.env.RESEND_REPLY_TO) body.reply_to = process.env.RESEND_REPLY_TO;
  const headers = { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey; // Resend dedupes retries
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  return { id: data.id, delivered_to: testTo || to, intended_for: to };
}

module.exports = { configured, sendEmail };
