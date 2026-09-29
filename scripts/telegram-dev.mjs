// Local bridge: long-polls Telegram and hands each update to the dev server.
//
// Telegram normally pushes updates to a public HTTPS webhook, which localhost
// cannot be. Polling sidesteps that, so the bot can be tried end to end before
// anything is deployed. Same route, same code path — only the transport differs.
//
//   npm run telegram:dev
//
// Prints the chat id of anyone who messages the bot, which is how you find the
// value for TELEGRAM_ALLOWED_CHAT_ID the first time.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
const TARGET = process.env.TELEGRAM_DEV_TARGET ?? "http://localhost:3000/api/telegram";
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set in .env.local");
  process.exit(1);
}

const me = await fetch(`${API}/getMe`).then((r) => r.json());
if (!me.ok) {
  console.error("Telegram rejected the token:", me.description);
  process.exit(1);
}
console.log(`Connected as @${me.result.username} (${me.result.first_name})`);

// A registered webhook and long polling are mutually exclusive.
const hook = await fetch(`${API}/getWebhookInfo`).then((r) => r.json());
if (hook.ok && hook.result.url) {
  console.log(`Removing webhook ${hook.result.url} so polling can take over.`);
  await fetch(`${API}/deleteWebhook`);
}

const allowed = (process.env.TELEGRAM_ALLOWED_CHAT_ID ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
console.log(
  allowed.length
    ? `Allowed chat ids: ${allowed.join(", ")}`
    : "No TELEGRAM_ALLOWED_CHAT_ID set — the bot will refuse everyone. Message it once and copy the id printed below.",
);
console.log(`Forwarding to ${TARGET}\nWaiting for messages… (ctrl+c to stop)\n`);

let offset = 0;
let failures = 0;

for (;;) {
  let updates;
  try {
    const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
    updates = await res.json();
    failures = 0;
  } catch (err) {
    // A dropped long-poll is routine; back off a little and carry on.
    failures += 1;
    if (failures > 5) console.error("Polling error:", err.message);
    await new Promise((r) => setTimeout(r, Math.min(failures * 1000, 10_000)));
    continue;
  }

  if (!updates.ok) {
    console.error("getUpdates failed:", updates.description);
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }

  for (const update of updates.result) {
    offset = update.update_id + 1;

    const message = update.message ?? update.callback_query?.message;
    const chatId = message?.chat?.id;
    const who = message?.chat?.username ? `@${message.chat.username}` : "";
    const kind = update.callback_query
      ? `button:${update.callback_query.data}`
      : update.message?.photo
        ? "photo"
        : "text";

    console.log(`→ chat id ${chatId} ${who} [${kind}]`);
    if (chatId && allowed.length && !allowed.includes(String(chatId))) {
      console.log(`  ↳ not in TELEGRAM_ALLOWED_CHAT_ID — the route will refuse it`);
    }

    const started = Date.now();
    try {
      const res = await fetch(TARGET, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(SECRET ? { "x-telegram-bot-api-secret-token": SECRET } : {}),
        },
        body: JSON.stringify(update),
      });
      console.log(`  ↳ ${res.status} in ${Date.now() - started}ms`);
      if (res.status === 401) {
        console.log("  ↳ secret mismatch: TELEGRAM_WEBHOOK_SECRET differs from the server's");
      }
    } catch (err) {
      console.log(`  ↳ could not reach ${TARGET} — is the dev server running? (${err.message})`);
    }
  }
}
