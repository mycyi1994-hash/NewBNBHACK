/**
 * pnpm alert:test — sends one test alert through the configured channel (Telegram when
 * TELEGRAM_BOT_TOKEN and TELEGRAM_OPS_CHAT_ID are set, the log otherwise). Evidence for M1-07
 * "알림 1회 실동작" and GOALS G5-4. Prints the channel and the result, never the token.
 */
import { createAlerter } from '@ijaro/agent';
import { loadConfig } from '@ijaro/config';

const config = loadConfig();
const { botToken, opsChatId } = config.telegram;
const alerter = createAlerter({
  telegram: botToken && opsChatId ? { botToken, chatId: opsChatId } : undefined,
});
const at = new Date().toISOString();
const result = await alerter.send({
  key: `test:${at}`,
  text: `[ijaro] test alert from ${config.regionTag ?? 'unset region'} at ${at} — no action needed.`,
});
console.log(`alert:test — channel ${alerter.channel}, result ${result}, at ${at}`);
if (result === 'failed') process.exitCode = 1;
