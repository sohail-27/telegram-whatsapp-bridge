# Telegram WhatsApp Bridge

A Node.js application that forwards messages between one Telegram group and one WhatsApp group.

## Features

- Two-way text forwarding
- Photos, documents, videos, audio files, and voice notes
- Locations and contacts
- Static stickers
- Reply bubbles for recently forwarded messages
- Loop prevention
- Automatic WhatsApp reconnection

## Technology Used

- Node.js
- Telegraf for Telegram
- Baileys for WhatsApp

## Requirements

- Node.js 18 or newer
- A Telegram bot added to your Telegram group
- A WhatsApp account linked using a QR code

## Installation

Clone the repository:

```bash
git clone git@github.com:sohail-27/telegram-whatsapp-bridge.git
cd telegram-whatsapp-bridge
```

Install packages:

```bash
npm install
```

## Environment Variables

Create a `.env` file in the project root. Use `.env.example` as the template.

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_GROUP_ID=your_telegram_group_id
WHATSAPP_GROUP_ID=your_whatsapp_group_id
```

Never upload `.env` because it contains private credentials.

## Run the Project

```bash
npm start
```

On the first run, scan the WhatsApp QR code from WhatsApp Linked Devices.

## Current Limitations

- Reply bubbles work only while the bridge is running because message mappings are stored in memory.
- Message edits and deletions are not synchronized.
- Reactions, animated stickers, and live locations are not yet synchronized.
