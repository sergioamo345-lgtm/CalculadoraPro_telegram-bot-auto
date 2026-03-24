const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_TOKEN;

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Bot funcionando 👊');
});

console.log('Bot rodando...');
