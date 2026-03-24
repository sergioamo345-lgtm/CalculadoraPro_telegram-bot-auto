const TelegramBot = require('node-telegram-bot-api');

// Pega o token das variáveis de ambiente
const token = process.env.TELEGRAM_TOKEN;

// Verificação de segurança
if (!token) {
  throw new Error("❌ TELEGRAM_TOKEN não definido nas variáveis de ambiente");
}

// Criação do bot
const bot = new TelegramBot(token, { polling: true });

// Teste simples
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🤖 Bot online e funcionando!");
});

// Log de erro do polling
bot.on("polling_error", (error) => {
  console.log("Erro de polling:", error.code, error.message);
});
