import 'dotenv/config';
import { Telegraf } from 'telegraf';
import makeWASocket, {
    Browsers,
    DisconnectReason,
    downloadEncryptedContent,
    downloadMediaMessage,
    useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode, { error } from 'qrcode-terminal';
import { quote } from 'telegraf/format';


console.log('Step 1: File started');

let isWhatsAppReady = false;// This flag will be set to true when WhatsApp is ready.

const bridgeSentWhatsAppMessageIds = new Set();
function rememberBridgeWhatsAppMessage(sentMessage) { // add WA message ID to bridgeSentWhatsAppMessageIds
    const messageId = sentMessage?.key?.id;

    if (messageId) {
        bridgeSentWhatsAppMessageIds.add(messageId);
    }
}


// ---------- Telegram setup ----------

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramGroupId = process.env.TELEGRAM_GROUP_ID;
const whatsappGroupId = process.env.WHATSAPP_GROUP_ID;


//Because it is inside the listener, JavaScript creates this same object again for every WhatsApp message. Earlier it was above imageMessage in WA listener.
const contactNames = {
    '158896660471898@lid': 'Sohail',
    '232143066259524@lid': 'Sohail'
};

const MAX_VIDEO_SIZE_BYTES = 16 * 1024 * 1024;



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


async function downloadTelegramFile(ctx, fileId) {
    const fileLink = await ctx.telegram.getFileLink(fileId); // Get the direct link to the photo file
    const response = await fetch(fileLink); // Fetch the photo from the link
    const arrayBuffer = await response.arrayBuffer(); //Convert the response to an ArrayBuffer,ArrayBuffer is a lowlevel representation of binary data,which is suitable for send to WA.

    return Buffer.from(arrayBuffer); // Convert the ArrayBuffer to a Node.js Buffer, which is what Baileys expects for media messages.
}


// Telegram text reply -> WhatsApp means IDENTIFYING THE OLDER MESSAGE TYPE
// This is for what user select to reply and w'll handle what to reply- go bottom of function
function getTelegramReplyText(ctx) {
    const repliedMessage = ctx.message.reply_to_message;

    if (!repliedMessage) {
        return '';
    }

    if (repliedMessage.text) {
        return repliedMessage.text;
    }

    if (repliedMessage.caption) {
        return repliedMessage.caption;
    }

    if (repliedMessage.photo) {
        return '[photo]';
    }

    if (repliedMessage.document) {
        return `[document: ${repliedMessage.document.file_name || 'file'}]`;
    }

    if (repliedMessage.video) {
        return '[video]';
    }

    if (repliedMessage.voice) {
        return '[voice note]';
    }

    if (repliedMessage.audio) {
        return `[audio: ${repliedMessage.audio.file_name || 'audio'}]`;
    }

    return '[message]';// If someone is reply to other than above like location, stickers, contact or unknown type

    // we also need to change the reply type like - for direct new message[implemented], for reply, change code in bot.on text
};

// WhatsApp text reply -> Telegram
function getWhatsAppQuotedText(message) {
    const contextInfo =
        message.message?.extendedTextMessage?.contextInfo ||
        message.message?.imageMessage?.contextInfo ||
        message.message?.documentMessage?.contextInfo ||
        message.message?.videoMessage?.contextInfo ||
        message.message?.audioMessage?.contextInfo;

    const quotedMessage = contextInfo?.quotedMessage;

    if (!quotedMessage) {
        return '';
    }

    if (quotedMessage.conversation) { // If old message was simple WA text, return it.
        return quotedMessage.conversation;
    }

    if (quotedMessage.extendedTextMessage?.text) { //If old message was extended text, return it. Like - font, formatting etc...
        return quotedMessage.extendedTextMessage.text;
    }

    if (quotedMessage.imageMessage) {
        return quotedMessage.imageMessage.caption || '[photo]';
    }

    if (quotedMessage.documentMessage) {
        return quotedMessage.documentMessage.caption ||
            `[document: ${quotedMessage.documentMessage.fileName || 'file'}]`;
    }

    if (quotedMessage.videoMessage) {
        return quotedMessage.videoMessage.caption || '[video]';
    }

    if (quotedMessage.audioMessage) {
        return quotedMessage.audioMessage.ptt ? '[voice note]' : '[audio]';
    }

    return '[message]';
}


// bot.on('message', (ctx) => {});

bot.on('text', async (ctx) => {

    if (String(ctx.chat.id) !== telegramGroupId) {
        return;
    }

    const senderName = ctx.from?.first_name || 'Unknown sender';
    const text = ctx.message.text;

    console.log(`[Telegram received] ${senderName}: ${text}`);

    //const forwardedText = `[Telegram] ${senderName}: ${text}`;
    const replyText = getTelegramReplyText(ctx);

    const forwardedText = replyText
        ? `[Telegram] ${senderName} replied to:\n"${replyText}"\n\n${text}`
        : `[Telegram] ${senderName}: ${text}`;


    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait for [WA] Ready before sending Telegram messages.');
            return;
        }
        const sentMessage = await whatsapp.sendMessage(whatsappGroupId, {
            text: forwardedText
        });
        rememberBridgeWhatsAppMessage(sentMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

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

        const photoBuffer = await downloadTelegramFile(ctx, bestPhoto.file_id);

        const sentMessage = await whatsapp.sendMessage(whatsappGroupId, {
            image: photoBuffer, // Send the photo as an image message
            caption: caption ? `[Telegram] ${senderName}: ${caption}` : `[Telegram] ${senderName} sent a photo.`
        });

        rememberBridgeWhatsAppMessage(sentMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds


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

        const documentBuffer = await downloadTelegramFile(ctx, document.file_id);

        const sentMessage = await whatsapp.sendMessage(whatsappGroupId, {
            document: documentBuffer,
            fileName: fileName,
            mimetype: mimeType,
            caption: caption
                ? `[Telegram] ${senderName}: ${caption}`
                : `[Telegram] ${senderName} sent a document: ${fileName}`
        });

        rememberBridgeWhatsAppMessage(sentMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        console.log(`Sent Telegram document to WhatsApp from ${senderName}: ${fileName}`);

    } catch (error) {
        console.error('Could not send Telegram document to WhatsApp:', error.message);
    }

});


// handle Video 
bot.on('video', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroupId) {
        return;
    }

    const caption = ctx.message.caption || '';
    const senderName = ctx.from?.first_name || 'Unknown sender';
    const video = ctx.message.video;

    console.log(`[Telegram video received] ${senderName}`);

    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait before sending Telegram videos.');
            return;
        }

        const videoBuffer = await downloadTelegramFile(ctx, video.file_id);

        const sentMessage = await whatsapp.sendMessage(whatsappGroupId, {
            video: videoBuffer,
            caption: caption ? `[Telegram] ${senderName}: ${caption}` : `[Telegram] ${senderName} sent a video.`
        });

        rememberBridgeWhatsAppMessage(sentMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        console.log(`Sent Telegram video to WhatsApp from ${senderName}`);

    } catch (error) {
        console.error('Could not send Telegram video to WhatsApp:', error.message);

    }

});

// handle voice note only
bot.on('voice', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroupId) {
        return;
    }

    const senderName = ctx.from?.first_name || 'Unknown sender';
    const voice = ctx.message.voice;

    console.log(`[Telegram voice received] ${senderName}`);

    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait before sending Telegram videos.');
            return;
        }


        const voiceBuffer = await downloadTelegramFile(ctx, voice.file_id);

        const sentVoiceMessage = await whatsapp.sendMessage(whatsappGroupId, {
            audio: voiceBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
        });

        rememberBridgeWhatsAppMessage(sentVoiceMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        const sentTextMessage = await whatsapp.sendMessage(whatsappGroupId, {
            text: `[Telegram] ${senderName} sent a voice note.`

        });

        rememberBridgeWhatsAppMessage(sentTextMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        console.log(`Sent Telegram voice note to WhatsApp from ${senderName}`);

    } catch (error) {
        console.error('Could not send Telegram voice note to WhatsApp:', error.message);

    }
});


// handle audio file only
bot.on('audio', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroupId) {
        return;
    }

    const senderName = ctx.from?.first_name || 'Unknown sender';
    const audio = ctx.message.audio;
    const caption = ctx.message.caption || ''; // TG doesn`t allow to send caption with, will discuss later and appreciate.
    const fileName = audio.file_name || 'telegram-audio';
    const mimeType = audio.mime_type || 'audio/mpeg';

    console.log(`[Telegram audio received] ${senderName}: ${fileName}`);

    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait before sending Telegram audio files.');
            return;
        }

        const audioBuffer = await downloadTelegramFile(ctx, audio.file_id);

        const sentAudioMessage = await whatsapp.sendMessage(whatsappGroupId, {
            audio: audioBuffer,
            mimetype: mimeType,
            fileName: fileName
        });

        rememberBridgeWhatsAppMessage(sentAudioMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        const sentTextMessage = await whatsapp.sendMessage(whatsappGroupId, {
            text: caption
                ? `[Telegram] ${senderName}: ${caption}`
                : `[Telegram] ${senderName} sent an audio file: ${fileName}`
        });

        rememberBridgeWhatsAppMessage(sentTextMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        console.log(`Sent Telegram audio to WhatsApp from ${senderName}: ${fileName}`);


    } catch (error) {
        console.error('Could not send Telegram audio to WhatsApp:', error.message);

    }
});

// Handle Location
bot.on('location', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroupId) {
        return;
    }

    const senderName = ctx.from?.first_name || 'Unknown sender';
    const location = ctx.message.location;

    console.log(`[Telegram location received] ${senderName}`);

    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait before sending Telegram audio files.');
            return;
        }

        const sentLocationMessage = await whatsapp.sendMessage(whatsappGroupId, {
            location: {
                degreesLatitude: location.latitude,
                degreesLongitude: location.longitude
            }
        });

        rememberBridgeWhatsAppMessage(sentLocationMessage);

        const sentTextMessage = await whatsapp.sendMessage(whatsappGroupId, {
            text: `[Telegram] ${senderName} shared a location.`
        });

        rememberBridgeWhatsAppMessage(sentTextMessage);

        console.log(`Sent Telegram location to WhatsApp from ${senderName}`);

    } catch (error) {
        console.error('Could not send Telegram location to WhatsApp:', error.message);

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

            if (shouldReconnect) {
                console.log('Reconnecting WhatsApp in 3 seconds...'); //A short pause helps when Wi‑Fi briefly drops, WhatsApp’s server is temporarily unavailable, or the old socket is still closing.

                setTimeout(() => {
                    startWhatsApp().catch((error) => { //.catch(...) prevents a reconnection error from becoming an unhandled crash and prints a clear reason instead.
                        console.error('WhatsApp reconnect failed:', error.message);
                    });

                }, 3000);
            } else {
                console.log('WhatsApp was logged out. Link the device again to continue.');

            }

        }
    });

    // 5. listen for new messages
    whatsapp.ev.on('messages.upsert', async (event) => {
        for (const message of event.messages) {
            const groupId = message.key.remoteJid;

            if (bridgeSentWhatsAppMessageIds.has(message.key.id)) {
                console.log('Skipping WhatsApp message because it was created by Telegram bridge.');
                bridgeSentWhatsAppMessageIds.delete(message.key.id);
                continue;
            }

            if (groupId !== whatsappGroupId) {
                //return;
                continue;
                /* not return, if Rahul from other group and shoaib from our group send message at same time then Bailey treat them
                 event.messages = [
                 rahulMessage,
                 shoaibMessage
                 ]; then return means stop everything but continue will checks every possibilities orr still processing for 2nd message. */
            }

            const senderId = message.key.participant || message.key.remoteJid;
            const cleanSenderId = senderId.replace('@lid', '').replace('@s.whatsapp.net', '');

            let senderName = contactNames[senderId] || `WhatsApp User ${cleanSenderId}`;

            // handle media messages (images for now)
            const imageMessage = message.message?.imageMessage;

            if (imageMessage) {
                try {
                    const caption = imageMessage.caption || '';

                    if (caption.startsWith('[Telegram]')) {
                        console.log('Skipping photo because it came from Telegram bridge.');
                        continue;
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

                //return;
                continue; // while sending this photo someone send something then loop has to check for that other message also but in 'return' it doesnot checks, it simply return whole upsert
            }

            // handle document messages for now
            const documentMessage = message.message?.documentMessage;

            if (documentMessage) {
                try {
                    const caption = documentMessage.caption || ''; // Get the caption if available

                    if (caption.startsWith('[Telegram]')) {
                        console.log('Skipping document because it came from Telegram bridge.');
                        continue;
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

                //return;
                continue;// while sending this photo someone send something then loop has to check for that other message also but in 'return' it doesnot checks, it simply return whole upsert
            }


            // handle video messages for now
            const videoMessage = message.message?.videoMessage;

            if (videoMessage) {
                try {
                    const caption = videoMessage.caption || '';

                    if (caption.startsWith('[Telegram]')) {
                        console.log('Skipping video because it came from Telegram bridge.');
                        continue;
                    }

                    const videoBuffer = await downloadMediaMessage(
                        message,
                        'buffer',
                        {},
                        {
                            logger: pino({ level: 'silent' }),
                            reuploadRequest: whatsapp.updateMediaMessage
                        }
                    );

                    await bot.telegram.sendVideo(
                        telegramGroupId,
                        { source: videoBuffer },
                        {
                            caption: caption ? `[WhatsApp] ${senderName}: ${caption}` : `[WhatsApp] ${senderName} sent a video.`
                        }
                    );

                    console.log(`Sent WhatsApp video to Telegram from ${senderName}`)

                } catch (error) {
                    console.error('Could not send WhatsApp video to Telegram:', error.message);

                }

                //return;
                continue;// while sending this photo someone send something then loop has to check for that other message also but in 'return' it doesnot checks, it simply return whole upsert

            }

            //handle audio message for now
            const audioMessage = message.message?.audioMessage;

            if (audioMessage) {
                try {
                    const audioBuffer = await downloadMediaMessage(
                        message,
                        'buffer',
                        {},
                        {
                            logger: pino({ level: 'silent' }),
                            reuploadRequest: whatsapp.updateMediaMessage
                        }
                    );

                    if (audioMessage.ptt) {
                        await bot.telegram.sendVoice(
                            telegramGroupId,
                            { source: audioBuffer },// else also have same output as audioBuffer but, diff is how TG will identify between audio and vioce notes and TG method sendVoice and sendAudio
                            {
                                caption: `[WhatsApp] ${senderName} sent a voice note.`
                            }
                        );

                        console.log(`Sent WhatsApp voice note to Telegram from ${senderName}`)

                    } else {
                        await bot.telegram.sendAudio(
                            telegramGroupId,
                            { source: audioBuffer },
                            {
                                caption: `[WhatsApp] ${senderName} sent an audio file.`
                            }
                        );

                        console.log(`Sent WhatsApp audio to Telegram from ${senderName}`)

                    }

                } catch (error) {
                    console.error('Could not send WhatsApp audio to Telegram:', error.message);
                }

                //return;
                continue;// while sending this photo someone send something then loop has to check for that other message also but in 'return' it doesnot checks, it simply return whole upsert

            }

            // hanlde location message
            const locationMessage = message.message?.locationMessage;

            if (locationMessage) {
                try {
                    await bot.telegram.sendLocation(
                        telegramGroupId,
                        locationMessage.degreesLatitude,
                        locationMessage.degreesLongitude
                    );

                    await bot.telegram.sendMessage(
                        telegramGroupId,
                        `[WhatsApp] ${senderName} shared a location.`
                    );

                    console.log(`Sent WhatsApp location to Telegram from ${senderName}`);

                } catch (error) {
                    console.error('Could not send WhatsApp location to Telegram:', error.message);
                }

                continue;
            }


            const text = message.message?.conversation || message.message?.extendedTextMessage?.text; // Check for text in both conversation and extendedTextMessage

            if (!text) {
                console.log('WhatsApp message has no text. We will handle media later.');
                //return;
                continue;
            }

            if (text.startsWith('[Telegram]')) {
                console.log('Skipping message because it came from Telegram bridge.');
                //return;
                continue;
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

            //const forwardedText = `[WhatsApp] ${senderName}: ${text}`;
            const quotedText = getWhatsAppQuotedText(message);

            const forwardedText = quotedText
                ? `[WhatsApp] ${senderName} replied to:\n"${quotedText}"\n\n${text}`
                : `[WhatsApp] ${senderName}: ${text}`;


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