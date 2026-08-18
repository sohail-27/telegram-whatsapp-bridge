import 'dotenv/config';
import { Telegraf } from 'telegraf';
import makeWASocket, {
    Browsers,
    DisconnectReason,
    downloadMediaMessage,
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

bot.on('photo', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroupId) {
        return;
    }

    const senderName = ctx.from?.first_name || 'Unknown sender';
    const caption = ctx.message.caption || '';

    console.log(`[Telegram photo received] ${senderName}`);

    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait before sending telegram photos.');
            return;
        }

        const photos = ctx.message.photo; // Get the array of photo sizes
        const bestPhoto = photos[photos.length - 1]; // Get the highest resolution photo (last in the array)

        const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id); // Get the direct link to the photo file
        const response = await fetch(fileLink); // Fetch the photo from the link
        const arrayBuffer = await response.arrayBuffer(); //Convert the response to an ArrayBuffer,ArrayBuffer is a lowlevel representation of binary data,which is suitable for send to WA.
        const photoBuffer = Buffer.from(arrayBuffer); // Convert the ArrayBuffer to a Node.js Buffer, which is what Baileys expects for media messages.

        await whatsapp.sendMessage(whatsappGroupId, {
            image: photoBuffer, // Send the photo as an image message
            caption: caption ? `[Telegram] ${senderName}: ${caption}` : `[Telegram] ${senderName} sent a photo.`
        });

        console.log(`Sent Telegram photo to WhatsApp from ${senderName}`);

    } catch (error) {
        console.error('Could not send Telegram photo to WhatsApp:', error.message);
    }
});

bot.on('document', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroupId) {
        return;
    }

    const senderName = ctx.from?.first_name || 'Unknown sender';
    const caption = ctx.message.caption || '';
    const document = ctx.message.document;
    const fileName = document.file_name || 'telegram-document';
    const mimeType = document.mime_type || 'application/octet-stream';

    console.log(`[Telegram document received] ${senderName}: ${fileName}`);

    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait before sending Telegram documents.');
            return;
        }


        const fileLink = await ctx.telegram.getFileLink(document.file_id)
        const response = await fetch(fileLink);
        const arrayBuffer = await response.arrayBuffer();
        const documentBuffer = Buffer.from(arrayBuffer);

        await whatsapp.sendMessage(whatsappGroupId, {
            document: documentBuffer,
            fileName: fileName,
            mimeType: mimeType,
            caption: caption
                ? `[Telegram] ${senderName}: ${caption}`
                : `[Telegram] ${senderName} sent a document: ${fileName}`
        });

        console.log(`Sent Telegram document to WhatsApp from ${senderName}: ${fileName}`);

    } catch (error) {
        console.error('Could not send Telegram document to WhatsApp:', error.message);
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

            const senderId = message.key.participant || message.key.remoteJid;
            const cleanSenderId = senderId.replace('@lid', '').replace('@s.whatsapp.net', '');

            const contactNames = {
                '158896660471898@lid': 'Sohail',
                '232143066259524@lid': 'Sohail'
            };

            let senderName = contactNames[senderId] || `WhatsApp User ${cleanSenderId}`;

            // handle media messages (images for now)
            const imageMessage = message.message?.imageMessage;

            if (imageMessage) {
                try {
                    const caption = imageMessage.caption || '';

                    if (caption.startsWith('[Telegram]')) {
                        console.log('Skipping photo because it came from Telegram bridge.');
                        return;
                    }

                    const photoBuffer = await downloadMediaMessage(
                        message,
                        'buffer',
                        {},
                        {
                            logger: pino({ level: 'silent' }),
                            reuploadRequest: whatsapp.updateMediaMessage
                        }
                    );

                    await bot.telegram.sendPhoto(
                        telegramGroupId,
                        { source: photoBuffer },
                        {
                            caption: caption ? `[WhatsApp] ${senderName}: ${caption}` : `[WhatsApp] ${senderName} sent a photo.`
                        }

                    );

                    console.log(`sent WhatsApp photo to Telegram from ${senderName}`);
                } catch (error) {
                    console.error('Could not send WhatsApp photo to Telegram:', error.message);
                }

                return; // Skip further processing for this message since it's a media message.
            }

            // handle document messages for now
            const documentMessage = message.message?.documentMessage;

            if (documentMessage) {
                try {
                    const caption = documentMessage.caption || ''; // Get the caption if available

                    if (caption.startsWith('[Telegram]')) {
                        console.log('Skipping document because it came from Telegram bridge.');
                        return;
                    }
                    
                    const fileName = documentMessage.fileName || 'whatsapp_document'; // Get the file name or use a default

                    const documentBuffer = await downloadMediaMessage(
                        message,
                        'buffer',
                        {},
                        {

                            logger: pino({ level: 'silent' }),
                            reuploadRequest: whatsapp.updateMediaMessage
                        }
                    );

                    await bot.telegram.sendDocument(
                        telegramGroupId,
                        {
                            source: documentBuffer,
                            filename: fileName
                        },
                        {
                            caption: caption
                                ? `[WhatsApp] ${senderName}: ${caption}`
                                : `[WhatsApp] ${senderName} sent a document: ${fileName}`
                        }
                    );

                    console.log(`Sent WhatsApp document to Telegram from ${senderName}: ${fileName}`);

                } catch (error) {
                    console.log('Could not send WhatsApp document to Telegram:', error.message);
                }

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