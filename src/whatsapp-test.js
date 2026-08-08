import makeWASocket, {
    Browsers,
    DisconnectReason,
    useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

async function startWhatsAppTest() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const whatsapp = makeWASocket({
        auth: state,
        browser: Browsers.macOS('Telegram WhatsApp Bridge'),
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    whatsapp.ev.on('creds.update', saveCreds);

    whatsapp.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Scan the QR code above using WhatsApp Linked Devices.');
            qrcode.generate(qr, { small:true });
        }

        if (connection === 'open') {
            console.log('Baileys WhatsApp is connected.');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log('WhatsApp connection closed.');
            console.log('Should reconnect:', shouldReconnect);

            if (shouldReconnect) {
                startWhatsAppTest();
            }
        }
    });

    whatsapp.ev.on('messages.upsert', async (event) => {
    for (const message of event.messages) {
        const text =
            message.message?.conversation ||
            message.message?.extendedTextMessage?.text;

        if (!text) {
            continue;
        }

        console.log('New WhatsApp text message:');
        console.log('From:', message.key.remoteJid);
        console.log('Text:', text);
    }
});
}

startWhatsAppTest().catch((error) => {
    console.error('Could not start WhatsApp test:', error);
});