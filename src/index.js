import 'dotenv/config';
import { Telegraf } from 'telegraf';
import whatsappWeb from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

console.log('Step 1: File started');

const { Client, LocalAuth } = whatsappWeb;

// ---------- Telegram setup ----------

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramGroupId = process.env.TELEGRAM_GROUP_ID;

if (!telegramToken) {
  throw new Error('TELEGRAM_BOT_TOKEN is missing from .env');
}

if (!telegramGroupId) {
  throw new Error('TELEGRAM_GROUP_ID is missing from .env');
}

const bot = new Telegraf(telegramToken);

bot.on('text', (ctx) => {
  if (String(ctx.chat.id) !== telegramGroupId) {
    return;
  }

  console.log(`[Telegram] ${ctx.from?.first_name}: ${ctx.message.text}`);
});

bot.catch((error) => {
  console.error('Telegram bot error:', error);
});

// ---------- WhatsApp setup ----------

// LocalAuth saves the QR login so you normally scan it only once.
const whatsapp = new Client({
  authStrategy: new LocalAuth({
    clientId: 'telegram-whatsapp-bridge'
  }),
  puppeteer: {
    headless: true
  }
});

// This runs when WhatsApp needs you to link your phone.
whatsapp.on('qr', (qr) => {
  console.log('Scan this QR code using WhatsApp Linked Devices:');
  qrcode.generate(qr, { small: true });
});

// This runs after WhatsApp login succeeds.
whatsapp.on('ready', () => {
  console.log('WhatsApp is connected.');
  console.log('Now ask someone to send a new message in your staff WhatsApp group.');
});

whatsapp.on('message_create', (message) => {
  // Incoming group messages use `from`.
  // Messages you send use `to`.
  const groupId = message.from.endsWith('@g.us')
    ? message.from
    : message.to;

  if (!groupId?.endsWith('@g.us')) {
    return;
  }

  console.log('WhatsApp group ID:', groupId);
  console.log('Message text:', message.body);
});

// ---------- Start and stop safely ----------

async function start() {
  console.log('Step 2: Starting Telegram...');

  bot.launch().catch((error) => {
    console.error('Telegram could not start:', error);
  });

  console.log('Step 3: Telegram listener started. Starting WhatsApp...');
  await whatsapp.initialize();
}

async function stop(signal) {
  console.log(`Stopping because of ${signal}...`);

  await bot.stop(signal);
  await whatsapp.destroy();

  process.exit(0);
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

start().catch((error) => {
  console.error('Could not start the bridge:', error);
  process.exit(1);
});