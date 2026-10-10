// Finishes Telegram setup: finds the chat you messaged the bot from, saves its
// id to .env as TELEGRAM_CHAT_ID, and sends a test message.
//
//   1. Put TELEGRAM_BOT_TOKEN=... in .env (from @BotFather).
//   2. Open your bot in Telegram and send it any message (or add it to a group
//      and send a message there).
//   3. node scripts/telegram-setup.js
//
// The token is never printed.

const fs = require('fs');
const path = require('path');

const ENV = path.join(__dirname, '..', '.env');
let env = fs.readFileSync(ENV, 'utf8');
const token = (env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m) || [])[1]?.trim();
if (!token) { console.log('✗ Add TELEGRAM_BOT_TOKEN=... to .env first (from @BotFather).'); process.exit(1); }

const tg = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
  return data.result;
};

(async () => {
  const me = await tg('getMe');
  console.log(`Bot: @${me.username}`);
  const updates = await tg('getUpdates', { limit: 50 });
  const chats = updates.map(u => (u.message || u.channel_post || u.my_chat_member)?.chat).filter(Boolean);
  const chat = chats.at(-1);
  if (!chat) { console.log(`✗ No messages yet. Open https://t.me/${me.username}, press Start, send "hi", then run this again.`); process.exitCode = 1; return; }

  const line = `TELEGRAM_CHAT_ID=${chat.id}`;
  env = /^TELEGRAM_CHAT_ID=.*$/m.test(env) ? env.replace(/^TELEGRAM_CHAT_ID=.*$/m, () => line) : `${env.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(ENV, env);
  console.log(`✓ Saved TELEGRAM_CHAT_ID for ${chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.id}`);

  await tg('sendMessage', { chat_id: chat.id, parse_mode: 'HTML', text: '✅ <b>Aangan front desk connected.</b>\nNew qualified enquiries, complaints and anything that needs Nikhil will be posted here.' });
  console.log('✓ Test message sent. Now run: node scripts/push-env.js');
})().catch(err => { console.log(`✗ ${err.message}`); process.exitCode = 1; });
