import 'dotenv/config';
import { Telegraf } from 'telegraf';
import makeWASocket, {
    Browsers,
    DisconnectReason,
    useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

console.log('Step 1: File started');

let isWhatsAppReady = false;// This flag will be set to true when WhatsApp is ready.


// ---------- Telegram setup ----------

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramGroupId = process.env.TELEGRAM_GROUP_ID;
const whatsappGroupId = process.env.WHATSAPP_GROUP_ID;



if (!telegramToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing from .env');
}

if (!telegramGroupId) {
    throw new Error('TELEGRAM_GROUP_ID is missing from .env');
}

if (!whatsappGroupId) {
    throw new Error('WHATSAPP_GROUP_ID is missing from .env');
}

const bot = new Telegraf(telegramToken);

// bot.on('message', (ctx) => {});

bot.on('text', async (ctx) => {

    if (String(ctx.chat.id) !== telegramGroupId) {
        return;
    }

    const senderName = ctx.from?.first_name || 'Unknown sender';
    const text = ctx.message.text;

    console.log(`[Telegram received] ${senderName}: ${text}`);

    const forwardedText = `[Telegram] ${senderName}: ${text}`;

    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait for [WA] Ready before sending Telegram messages.');
            return;
        }
        await whatsapp.sendMessage(whatsappGroupId, { text: forwardedText });

        console.log('Sent Telegram message to WhatsApp:', forwardedText);
    } catch (error) {
        console.error('Could not send Telegram message to Whatsapp:', error.message);
    }
});

bot.catch((error) => {
    console.error('Telegram bot error:', error.message);
});



// ---------- WhatsApp setup ----------

let whatsapp;

async function startWhatsApp() {

    // 1. load auth state
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    //2. Create WhatsApp socket
    whatsapp = makeWASocket({
        auth: state,
        browser: Browsers.macOS('Telegram WhatsApp Bridge'),
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    // 3. save credentials when updated
    whatsapp.ev.on('creds.update', saveCreds);

    // 4. listen for connection update
    whatsapp.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;


        if (qr) {
            console.log('Scan this QR code using WhatsApp Linked Devices:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') { //If WhatsApp connection is open, it means connected.
            isWhatsAppReady = true; // Set the flag to true when WhatsApp is ready.
            console.log('Baileys WhatsApp is connected.');
        }

        if (connection === 'close') {
            isWhatsAppReady = false; // Set the flag to false when WhatsApp is disconnected.

            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log('WhatsApp connection closed.');
            console.log('Should reconnect:', shouldReconnect); // Log whether it should reconnect or not.

            if (shouldReconnect) {
                startWhatsApp(); // Attempt to reconnect if it should.
            }
        }
    });

    // 5. listen for new messages
    whatsapp.ev.on('messages.upsert', async (event) => {
        for (const message of event.messages) {
            const groupId = message.key.remoteJid;

            if (groupId !== whatsappGroupId) {
                return;
            }

            const text = message.message?.conversation || message.message?.extendedTextMessage?.text; // Check for text in both conversation and extendedTextMessage

            if (!text) {
                console.log('WhatsApp message has no text. We will handle media later.');
                return;
            }

            if (text.startsWith('[Telegram]')) {
                console.log('Skipping message because it came from Telegram bridge.');
                return;
            }

            const senderId = message.key.participant || message.key.remoteJid;
            const cleanSenderId = senderId.replace('@lid', '').replace('@s.whatsapp.net', '');

            const contactNames = {
                '158896660471898@lid': 'Sohail'
            };

            let senderName = contactNames[senderId] || `WhatsApp User ${cleanSenderId}`;

            try {
                const metadata = await whatsapp.groupMetadata(groupId);

                const participant = metadata.participants.find((member) => {
                    return member.id === senderId;
                });

                senderName =
                    contactNames[senderId] ||
                    participant?.name ||
                    participant?.notify ||
                    participant?.verifiedName ||
                    `WhatsApp User ${cleanSenderId}`;
            } catch (error) {
                console.log('Could not get WhatsApp group sender name. Using contact map/fallback.');
            }

            const forwardedText = `[WhatsApp] ${senderName}: ${text}`;
            try {
                await bot.telegram.sendMessage(telegramGroupId, forwardedText);
                console.log('Sent WhatsApp message to Telegram:', forwardedText);
            } catch (error) {
                console.error('Could not send WhatsApp message to Telegram:', error.message);
            }
        }
    });


}


// ---------- Start and stop safely ----------

async function start() {
    console.log('Step 2: Starting Telegram...');

    bot.launch().catch((error) => {
        console.error('Telegram could not start:', error.message);
    });
    console.log('Telegram bot is running and listening for messages.');

    console.log('Step 3: Starting WhatsApp...');

    await startWhatsApp();

    console.log('WhatsApp start command sent.')
}

async function stop(signal) {
    console.log(`Stopping because of ${signal}...`);

    await bot.stop(signal);
    whatsapp?.end(); // Safely end the WhatsApp connection if it exists.

    process.exit(0);
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

start().catch((error) => {
    console.error('Could not start the bridge:', error.message);
    process.exit(1);
});