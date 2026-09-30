/**
 * The few Telegram calls that more than one route needs.
 *
 * The webhook owns the conversation; the scheduled follow-up job only needs
 * to be able to start one. Sharing these keeps the bot token read in one
 * place and the allowlist honoured by both.
 */

const API = "https://api.telegram.org/bot";

export function botToken(): string {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  return value;
}

export function botConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}

export async function tg(method: string, payload: unknown) {
  const res = await fetch(`${API}${botToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`[telegram] ${method} ${res.status}`, (await res.text()).slice(0, 200));
  return res;
}

export const say = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id, text, disable_web_page_preview: true, ...extra });

export function allowedChatIds(): number[] {
  return (process.env.TELEGRAM_ALLOWED_CHAT_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/** Only the owner may use the bot — it spends API quota and sends as them. */
export function allowed(chatId: number): boolean {
  return allowedChatIds().includes(chatId);
}

/** Where an unprompted message — a daily digest, a follow-up offer — goes. */
export function primaryChatId(): number | null {
  return allowedChatIds()[0] ?? null;
}

export const fileUrl = (path: string) => `${API}${botToken()}/${path}`;
