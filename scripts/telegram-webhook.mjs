// Registers the deployed app as the bot's webhook. Run once after deploying.
//
//   node --env-file=.env.local scripts/telegram-webhook.mjs https://your-app.vercel.app
//
// Pass --status to see the current registration, or --delete to remove it
// (which is also what `npm run telegram:dev` does, since polling and webhooks
// cannot both be active).

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set in .env.local");
  process.exit(1);
}

const arg = process.argv[2];

async function show() {
  const info = await fetch(`${API}/getWebhookInfo`).then((r) => r.json());
  const r = info.result ?? {};
  console.log("url                  :", r.url || "(none)");
  console.log("pending updates      :", r.pending_update_count ?? 0);
  console.log("custom certificate   :", Boolean(r.has_custom_certificate));
  if (r.last_error_message) {
    console.log("last error           :", r.last_error_message);
    console.log("last error at        :", new Date((r.last_error_date ?? 0) * 1000).toISOString());
  }
}

if (arg === "--status") {
  await show();
  process.exit(0);
}

if (arg === "--delete") {
  const res = await fetch(`${API}/deleteWebhook`).then((r) => r.json());
  console.log(res.ok ? "Webhook removed." : `Failed: ${res.description}`);
  process.exit(res.ok ? 0 : 1);
}

if (!arg || !/^https:\/\//.test(arg)) {
  console.error(
    "Usage: node --env-file=.env.local scripts/telegram-webhook.mjs https://your-app.vercel.app",
  );
  console.error("       (Telegram requires HTTPS; localhost will not work — use telegram:dev.)");
  process.exit(1);
}

if (!SECRET) {
  console.error("TELEGRAM_WEBHOOK_SECRET is not set. Set one first — without it the URL is the");
  console.error("only thing standing between your bot and anyone who guesses it.");
  process.exit(1);
}

const url = `${arg.replace(/\/+$/, "")}/api/telegram`;
const res = await fetch(`${API}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  }),
}).then((r) => r.json());

if (!res.ok) {
  console.error("Failed:", res.description);
  process.exit(1);
}

console.log(`Webhook set to ${url}\n`);
await show();
