const TelegramBot = require('node-telegram-bot-api');

// pega o token das variáveis do Railway
const token = process.env.TELEGRAM_TOKEN;

// cria o bot
const bot = new TelegramBot(token, { polling: true });

// comando /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Bot funcionando 👊');
});

// comando de teste
bot.onText(/\/teste/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Teste OK ✅');
});

console.log('Bot rodando...');
