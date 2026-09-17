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

const bridgeSentWhatsAppMessageIds = new Set(); // stores WhatsApp message IDs that were sent by the bridge, so we can ignore them when they come back from WhatsApp. This prevents loops where a message sent from Telegram to WhatsApp is then forwarded back to Telegram.

const telegramToWhatsAppMessages = new Map(); // stores - Telegram message ID → full matching WhatsApp message for native text reply bubbles. We store the full WhatsApp message object, not only ABC123, because Baileys needs the full WhatsApp message when we ask it to create a real reply bubble.
const whatsappToTelegramMessageIds = new Map(); // stores - WhatsApp message ID → matching Telegram message ID for native text reply bubbles.

function rememberBridgeWhatsAppMessage(sentMessage) { // add WA message ID to bridgeSentWhatsAppMessageIds
    const messageId = sentMessage?.key?.id;

    if (messageId) {
        bridgeSentWhatsAppMessageIds.add(messageId);
    }
}


// It does three jobs
// 1. Connect Telegram and WhatsApp copies of the same message
// 2. Save the connection in both directions
// 3. Remove old connections when there are too many
// --------- It does not ----------
// send any message
// forward any media
// create the reply bubble itself
const MAX_REPLY_MAPPINGS = 500;

function rememberReplyMapping(telegramMessageId, whatsappMessage) { //rememberReplyMapping holds the mapping of WhatsApp message ID to Telegram message ID for future replies.
    const whatsappMessageId = whatsappMessage?.key?.id;

    if (!telegramMessageId || !whatsappMessageId) {
        return;
    }

    telegramToWhatsAppMessages.set( // Telegram ID → WhatsApp message, because Baileys needs the full WhatsApp message to create a real reply bubble
        telegramMessageId,
        whatsappMessage
    );

    whatsappToTelegramMessageIds.set( // WhatsApp ID → Telegram ID, because Telegraf only needs the Telegram message ID to create a real reply bubble
        whatsappMessageId,
        telegramMessageId
    );

    if (telegramToWhatsAppMessages.size > MAX_REPLY_MAPPINGS) {
        const oldestTelegramMessageId = telegramToWhatsAppMessages.keys().next().value; //contains the Telegram ID,

        const oldestWhatsAppMessage = telegramToWhatsAppMessages.get(oldestTelegramMessageId); // while the this contains the full WhatsApp message object.

        telegramToWhatsAppMessages.delete(oldestTelegramMessageId); // is stored in the Map, this deletes that whole stored entry: 501 → WA-ABC123

        if (oldestWhatsAppMessage?.key?.id) { //checks whether the saved old WhatsApp message object has an ID available.

            whatsappToTelegramMessageIds.delete(oldestWhatsAppMessage.key.id); //oldestWhatsAppMessage.key.id = WA-ABC123, deletes the matching reverse mapping: WA-ABC123 → 501
        }
    }

    //     Save relationship:
    // Telegram 101 ↔ WhatsApp ABC123

    // When over 500:
    // Remove both sides:
    // Telegram 101 ✕ WhatsApp ABC123

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

// for TG chat ID, we can use it to filter messages from a specific group or chat. This is useful if you want to only process messages from a certain group and ignore others. The chat ID can be obtained by sending a message to the bot and checking the logs for the chat ID.
// bot.on('message', (ctx) => {
//     console.log('[TG ID check]', {
//         received: String(ctx.chat.id),
//         configured: telegramGroupId,
//         match: String(ctx.chat.id) === telegramGroupId
//     });
// });


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
};


function getWhatsAppContextInfo(message) {
    return (
        message.message?.extendedTextMessage?.contextInfo ||
        message.message?.imageMessage?.contextInfo ||
        message.message?.documentMessage?.contextInfo ||
        message.message?.videoMessage?.contextInfo ||
        message.message?.audioMessage?.contextInfo ||
        message.message?.stickerMessage?.contextInfo ||
        message.message?.locationMessage?.contextInfo ||
        message.message?.contactMessage?.contextInfo ||
        message.message?.contactsArrayMessage?.contextInfo
    );
}

// The getWhatsAppQuotedMessageId holds:
// Reply message → older WhatsApp message ID
// Normal message → empty string
function getWhatsAppQuotedMessageId(message) {
    return getWhatsAppContextInfo(message)?.stanzaId || '';
}

// This function is used to get the reply options for a Telegram message that is replying to a WhatsApp message. It checks if the Telegram message is a reply to another message, and if so, it looks up the corresponding WhatsApp message in the telegramToWhatsAppMessages map. If a matching WhatsApp message is found, it returns an object with the quoted property set to that WhatsApp message. If no matching WhatsApp message is found, it returns undefined.
function getTelegramWhatsAppReplyOptions(ctx) {
    const repliedTelegramMessageId =
        ctx.message.reply_to_message?.message_id; // ID of reply to message e.g - 101 means old message ID of Telegram message

    const quotedWhatsAppMessage = repliedTelegramMessageId  // quotedWAMessage holds the full WhatsApp message object for the old message bubble.
        ? telegramToWhatsAppMessages.get(repliedTelegramMessageId) //The Map gives us the matching WhatsApp message:WhatsApp message ABC123 attach with 101 ID of TG
        : undefined;

    return quotedWhatsAppMessage
        ? { quoted: quotedWhatsAppMessage } // ***This is basicallly the old message bubble, if found in MAP then send new text with that old message bubble, if not found then send new text with old format of reply.
        : undefined;
}

// This function is used to get the reply options for a WhatsApp message that is replying to a Telegram message. It checks if the WhatsApp message is a reply to another message, and if so, it looks up the corresponding Telegram message ID in the whatsappToTelegramMessageIds map. If a matching Telegram message ID is found, it returns an object with the reply_parameters property set to an object containing the message_id of the replied Telegram message. If no matching Telegram message ID is found, it returns an empty object.
function getWhatsAppTelegramReplyOptions(message) {
    const quotedWhatsAppMessageId =
        getWhatsAppQuotedMessageId(message); // holds that old message ID

    const repliedTelegramMessageId = quotedWhatsAppMessageId
        ? whatsappToTelegramMessageIds.get(quotedWhatsAppMessageId) // Find in map for old message with that above ID
        : undefined;

    // this is the old message ID of that old message bubble, if found in MAP then send new text with that old message bubble, if not found then send new text with old format of reply.
    return repliedTelegramMessageId
        ? {
            reply_parameters: {
                message_id: repliedTelegramMessageId // ***create a reply bubble in Telegram with that old message ID, if found in MAP then send new text with that old message bubble, if not found then send new text with old format of reply.
            }
        }
        : {};
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
    const replyText = getTelegramReplyText(ctx);// Type of message [older one]

    const repliedTelegramMessageId =
        ctx.message.reply_to_message?.message_id; // ID of reply to message e.g - 101

    const quotedWhatsAppMessage = // quotedWAMessage holds the full WhatsApp message object for the old message bubble.
        repliedTelegramMessageId
            ?
            telegramToWhatsAppMessages.get(repliedTelegramMessageId) //The Map gives us the matching WhatsApp message:WhatsApp message ABC123 attach with 101 ID of TG
            : undefined;


    const forwardedText = quotedWhatsAppMessage
        ? `[Telegram] ${senderName}: ${text}`
        : replyText //Does Telegram still provide the text of the old message?
            ? `[Telegram] ${senderName} replied to:\n"${replyText}"\n\n${text}`
            : `[Telegram] ${senderName}: ${text}`;



    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait for [WA] Ready before sending Telegram messages.');
            return;
        }
        const sentMessage = await whatsapp.sendMessage(
            whatsappGroupId,
            {
                text: forwardedText
            },
            quotedWhatsAppMessage
                ? { quoted: quotedWhatsAppMessage } //Send new WhatsApp message as a reply to this older WhatsApp message.
                : undefined);

        // Prevents loops.
        rememberBridgeWhatsAppMessage(sentMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        rememberReplyMapping(ctx.message.message_id, sentMessage); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

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

        const whatsappReplyOptions = getTelegramWhatsAppReplyOptions(ctx);

        const sentMessage = await whatsapp.sendMessage(whatsappGroupId, {
            image: photoBuffer, // Send the photo as an image message
            caption: caption ? `[Telegram] ${senderName}: ${caption}` : `[Telegram] ${senderName} sent a photo.`
        },
            whatsappReplyOptions // If the Telegram message is a reply to another message, this will include the quoted WhatsApp message for proper reply threading.
        );

        rememberBridgeWhatsAppMessage(sentMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        rememberReplyMapping(ctx.message.message_id, sentMessage); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.


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

        const whatsappReplyOptions = getTelegramWhatsAppReplyOptions(ctx);

        const sentMessage = await whatsapp.sendMessage(whatsappGroupId, {
            document: documentBuffer,
            fileName: fileName,
            mimetype: mimeType,
            caption: caption
                ? `[Telegram] ${senderName}: ${caption}`
                : `[Telegram] ${senderName} sent a document: ${fileName}`
        },
            whatsappReplyOptions
        );

        rememberBridgeWhatsAppMessage(sentMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        rememberReplyMapping(ctx.message.message_id, sentMessage); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

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

        const whatsappReplyOptions = getTelegramWhatsAppReplyOptions(ctx);

        const sentMessage = await whatsapp.sendMessage(whatsappGroupId, {
            video: videoBuffer,
            caption: caption ? `[Telegram] ${senderName}: ${caption}` : `[Telegram] ${senderName} sent a video.`
        },
            whatsappReplyOptions
        );

        rememberBridgeWhatsAppMessage(sentMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        rememberReplyMapping(ctx.message.message_id, sentMessage); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

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

        const whatsappReplyOptions = getTelegramWhatsAppReplyOptions(ctx);

        const sentVoiceMessage = await whatsapp.sendMessage(whatsappGroupId, {
            audio: voiceBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
        }, whatsappReplyOptions);

        rememberBridgeWhatsAppMessage(sentVoiceMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        rememberReplyMapping(ctx.message.message_id, sentVoiceMessage); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

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

        const whatsappReplyOptions = getTelegramWhatsAppReplyOptions(ctx);

        const sentAudioMessage = await whatsapp.sendMessage(whatsappGroupId, {
            audio: audioBuffer,
            mimetype: mimeType,
            fileName: fileName
        }, whatsappReplyOptions);

        rememberBridgeWhatsAppMessage(sentAudioMessage);// call function to add WA message ID to bridgeSentWhatsAppMessageIds

        rememberReplyMapping(ctx.message.message_id, sentAudioMessage); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

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

        const whatsappReplyOptions = getTelegramWhatsAppReplyOptions(ctx);

        const sentLocationMessage = await whatsapp.sendMessage(whatsappGroupId, {
            location: {
                degreesLatitude: location.latitude,
                degreesLongitude: location.longitude
            }
        }, whatsappReplyOptions);

        rememberBridgeWhatsAppMessage(sentLocationMessage);

        rememberReplyMapping(ctx.message.message_id, sentLocationMessage); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

        const sentTextMessage = await whatsapp.sendMessage(whatsappGroupId, {
            text: `[Telegram] ${senderName} shared a location.`
        });

        rememberBridgeWhatsAppMessage(sentTextMessage);

        console.log(`Sent Telegram location to WhatsApp from ${senderName}`);

    } catch (error) {
        console.error('Could not send Telegram location to WhatsApp:', error.message);

    }

});


// Hanlde Contact
bot.on('contact', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroupId) {
        return;
    }

    const senderName = ctx.from?.first_name || 'Unknown sender';
    const contact = ctx.message.contact;

    const fullName = [
        contact.first_name,
        contact.last_name
    ].filter(Boolean).join(' '); // remove unwanted spaces or other stuff and join name with leading space & .filter(Boolean) - removes empty or missing values:

    const phoneNumber = contact.phone_number;
    const whatsappId = phoneNumber.replace(/\D/g, ''); // replace non-digit character

    console.log(`[Telegram contact received] ${senderName}: ${fullName}`);

    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait before sending Telegram contacts.');
            return;
        }

        const vcard = [
            'BEGIN:VCARD',
            'VERSION:3.0',
            `FN:${fullName}`,
            `TEL;type=CELL;type=VOICE;waid=${whatsappId}:${phoneNumber}`,
            'END:VCARD'
        ].join('\n');

        const whatsappReplyOptions = getTelegramWhatsAppReplyOptions(ctx);

        const sentContactMessage = await whatsapp.sendMessage(whatsappGroupId, {
            contacts: {
                displayName: fullName,
                contacts: [{ vcard }]
            }
        }, whatsappReplyOptions);

        rememberBridgeWhatsAppMessage(sentContactMessage);

        rememberReplyMapping(ctx.message.message_id, sentContactMessage); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

        const sentTextMessage = await whatsapp.sendMessage(whatsappGroupId, {
            text: `[Telegram] ${senderName} shared contact: ${fullName}`
        });

        rememberBridgeWhatsAppMessage(sentTextMessage);

        console.log(`Sent Telegram contact to WhatsApp from ${senderName}`);

    } catch (error) {
        console.error('Could not send Telegram contact to WhatsApp:', error.message);
    }

});


// Handle Static Stickersl
bot.on('sticker', async (ctx) => {
    if (String(ctx.chat.id) !== telegramGroupId) {
        return;
    }

    const senderName = ctx.from?.first_name || 'Unknown sender';
    const sticker = ctx.message.sticker;

    console.log(`[Telegram sticker received] ${senderName}`);

    if (sticker.is_animated || sticker.is_video) {
        console.log('Only static Telegram stickers are supported right now.');
        return;
    }

    try {
        if (!isWhatsAppReady) {
            console.log('WhatsApp is not ready yet. Please wait before sending Telegram stickers.');
            return;
        }

        const stickerBuffer = await downloadTelegramFile(ctx, sticker.file_id);

        const whatsappReplyOptions = getTelegramWhatsAppReplyOptions(ctx);

        const sentStickerMessage = await whatsapp.sendMessage(whatsappGroupId, {
            sticker: stickerBuffer
        }, whatsappReplyOptions);

        rememberBridgeWhatsAppMessage(sentStickerMessage);

        rememberReplyMapping(ctx.message.message_id, sentStickerMessage); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

        const sentTextMessage = await whatsapp.sendMessage(whatsappGroupId, {
            text: `[Telegram] ${senderName} sent a sticker.`
        });

        rememberBridgeWhatsAppMessage(sentTextMessage);

        console.log(`Sent Telegram sticker to WhatsApp from ${senderName}`);

    } catch (error) {
        console.error('Could not send Telegram sticker to WhatsApp:', error.message);
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
        if (event.type !== 'notify') {// Ex - if message send after bridge off then do not forward it to TG while bridge on, fot that we will use ** PM2 - upervisor of our bridge
            return;
        }
        for (const message of event.messages) {
            const groupId = message.key.remoteJid;

            // console.log('[WhatsApp chat ID]', groupId); // Log the WhatsApp chat ID

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

            let senderName =
                message.pushName ||
                contactNames[senderId] ||
                `WhatsApp User ${cleanSenderId}`;

            const photoQuotedWhatsAppMessageId = getWhatsAppQuotedMessageId(message);// holds the WhatsApp message ID of the older message that this new message is replying to, if it exists.

            const photoRepliedTelegramMessageId = photoQuotedWhatsAppMessageId // holds the Telegram message ID that corresponds to the quoted WhatsApp message ID, if it exists in the mapping.
                ? whatsappToTelegramMessageIds.get(photoQuotedWhatsAppMessageId)
                : undefined;


            const telegramReplyOptions = photoRepliedTelegramMessageId // holds the Telegram reply options for the new message, if it is a reply to an older WhatsApp message that has a corresponding Telegram message ID in the mapping.
                ? {
                    reply_to_message_id: photoRepliedTelegramMessageId
                }
                : {};
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

                    const sentTelegramPhoto = await bot.telegram.sendPhoto(
                        telegramGroupId,
                        { source: photoBuffer },
                        {
                            caption: caption ? `[WhatsApp] ${senderName}: ${caption}` : `[WhatsApp] ${senderName} sent a photo.`,
                            ...telegramReplyOptions
                        }
                    );

                    rememberReplyMapping(sentTelegramPhoto.message_id, message); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

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

                    const sentTelegramDocument = await bot.telegram.sendDocument(
                        telegramGroupId,
                        {
                            source: documentBuffer,
                            filename: fileName
                        },
                        {
                            caption: caption
                                ? `[WhatsApp] ${senderName}: ${caption}`
                                : `[WhatsApp] ${senderName} sent a document: ${fileName}`,
                            ...telegramReplyOptions
                        }

                    );

                    rememberReplyMapping(sentTelegramDocument.message_id, message); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

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

                    const sentTelegramVideo = await bot.telegram.sendVideo(
                        telegramGroupId,
                        { source: videoBuffer },
                        {
                            caption: caption ? `[WhatsApp] ${senderName}: ${caption}` : `[WhatsApp] ${senderName} sent a video.`
                            ,
                            ...telegramReplyOptions
                        }

                    );

                    rememberReplyMapping(sentTelegramVideo.message_id, message); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

                    console.log(`Sent WhatsApp video to Telegram from ${senderName}`)

                } catch (error) {
                    console.error('Could not send WhatsApp video to Telegram:', error.message);

                }

                //return;
                continue;// while sending this photo someone send something then loop has to check for that other message also but in 'return' it doesnot checks, it simply return whole upsert

            }


            //handle static sticker share
            const stickerMessage = message.message?.stickerMessage;

            if (stickerMessage) {
                if (stickerMessage.isAnimated) {
                    console.log('Only static WhatsApp stickers are supported right now.');
                    continue;
                }

                try {
                    const stickerBuffer = await downloadMediaMessage(
                        message, // which WhatsApp message to download
                        'buffer', // return the downloaded file as a Buffer
                        {}, // extra download options — currently none
                        { // recovery/logging settings

                            logger: pino({ level: 'silent' }),
                            reuploadRequest: whatsapp.updateMediaMessage
                        }
                    );

                    const sentTelegramSticker = await bot.telegram.sendSticker(
                        telegramGroupId,
                        { source: stickerBuffer },
                        telegramReplyOptions
                    );

                    rememberReplyMapping(sentTelegramSticker.message_id, message); // call function to add mapping of WhatsApp message ID to Telegram message ID for future replies.

                    await bot.telegram.sendMessage(
                        telegramGroupId,
                        `[WhatsApp] ${senderName} sent a sticker.`
                    );

                    console.log(`Sent WhatsApp sticker to Telegram from ${senderName}`);

                } catch (error) {
                    console.error('Could not send WhatsApp sticker to Telegram:', error.message);
                }
                continue; //someone send something then loop has to check for that other message also but in 'return' it doesnot checks, it simply return whole upsert
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
                        const sentTelegramVoice = await bot.telegram.sendVoice(
                            telegramGroupId,
                            { source: audioBuffer },
                            {
                                caption: `[WhatsApp] ${senderName} sent a voice note.`
                                ,
                                ...telegramReplyOptions
                            }

                        );

                        rememberReplyMapping(sentTelegramVoice.message_id, message);

                        console.log(`Sent WhatsApp voice note to Telegram from ${senderName}`)

                    } else {
                        const sentTelegramAudio = await bot.telegram.sendAudio(
                            telegramGroupId,
                            { source: audioBuffer },
                            {
                                caption: `[WhatsApp] ${senderName} sent an audio file.`

                                , ...telegramReplyOptions
                            });

                        rememberReplyMapping(sentTelegramAudio.message_id, message);
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
                    const sentTelegramLocation = await bot.telegram.sendLocation(
                        telegramGroupId,
                        locationMessage.degreesLatitude,
                        locationMessage.degreesLongitude,
                        telegramReplyOptions

                    );

                    rememberReplyMapping(sentTelegramLocation.message_id, message);

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


            // handle share contact
            const whatsappContacts =
                message.message?.contactsArrayMessage?.contacts ||
                (message.message?.contactMessage
                    ? [message.message.contactMessage]
                    : []
                );

            if (whatsappContacts.length > 0) {
                try {
                    let sentContactCount = 0;

                    for (const sharedContact of whatsappContacts) {
                        const vcard = sharedContact.vcard || '';

                        const fullName =
                            vcard.match(/^FN:(.+)$/m)?.[1]?.trim() ||
                            sharedContact.displayName ||
                            'WhatsApp contact';

                        const phoneLine = vcard
                            .split(/\r?\n/)
                            .find((line) => line.toUpperCase().includes('TEL'));

                        const phoneNumber = phoneLine
                            ?.split(':')
                            .slice(1)
                            .join(':')
                            .trim();

                        if (!phoneNumber) {
                            console.log('Could not read a phone number from this WhatsApp contact.');
                            continue;
                        }

                        const sentTelegramContact = await bot.telegram.sendContact(
                            telegramGroupId,
                            phoneNumber,
                            fullName,
                            telegramReplyOptions

                        );

                        rememberReplyMapping(sentTelegramContact.message_id, message);

                        sentContactCount += 1;
                    }

                    if (sentContactCount > 0) {
                        await bot.telegram.sendMessage(
                            telegramGroupId,
                            `[WhatsApp] ${senderName} shared ${sentContactCount} contact(s).`
                        );

                        console.log(`Sent WhatsApp contact(s) to Telegram from ${senderName}`);
                    }
                } catch (error) {
                    console.error('Could not send WhatsApp contact to Telegram:', error.message);
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
            const quotedText = getWhatsAppQuotedText(message); // holds the text of the older WhatsApp message if this is a reply, or undefined if not a reply.

            const quotedWhatsAppMessageId = getWhatsAppQuotedMessageId(message); // holds that old message ID

            const repliedTelegramMessageId = quotedWhatsAppMessageId
                ? whatsappToTelegramMessageIds.get(quotedWhatsAppMessageId) // Find in map for old message with that above ID
                : undefined;

            const forwardedText = repliedTelegramMessageId // if reply
                ? `[WhatsApp] ${senderName}: ${text}` // then this is new text with that old reply bubble message, if old message found in MAP
                : quotedText
                    ? `[WhatsApp] ${senderName} replied to:\n"${quotedText}"\n\n${text}` // this is also new text but only works when old Message not in map then send new reply with old format old message.
                    : `[WhatsApp] ${senderName}: ${text}`; // this is also new message only when normal new messsage[no reply]


            try {
                const sentTelegramMessage = await bot.telegram.sendMessage(
                    telegramGroupId,
                    forwardedText, // this is the new text with or without old message bubble, if old message found in MAP then send new text with that old message bubble, if not found then send new text with old format of reply.
                    repliedTelegramMessageId // this is the old message ID of that old message bubble, if found in MAP then send new text with that old message bubble, if not found then send new text with old format of reply.
                        ? {
                            reply_parameters: {
                                message_id: repliedTelegramMessageId // create a reply bubble in Telegram with that old message ID, if found in MAP then send new text with that old message bubble, if not found then send new text with old format of reply.
                            }
                        }
                        : undefined
                );

                rememberReplyMapping( // holds the mapping of WhatsApp message ID to Telegram message ID for future replies.
                    sentTelegramMessage.message_id,
                    message // message from loop
                );

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