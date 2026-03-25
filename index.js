const TelegramBot = require('node-telegram-bot-api');
const mercadopago = require('mercadopago');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// Inicia bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Configura Mercado Pago
mercadopago.configure({
    access_token: process.env.MP_ACCESS_TOKEN
});

// Log para verificar se o token foi carregado
console.log("Token Mercado Pago:", process.env.MP_ACCESS_TOKEN ? "OK" : "NÃO ENCONTRADO");

// ===== FUNÇÃO PIX =====
async function criarPagamento(email) {
    const payment_data = {
        transaction_amount: 10.00,
        description: "Acesso Calculadora Pro",
        payment_method_id: "pix",
        payer: {
            email: email || "cliente@email.com"
        }
    };

    try {
        const pagamento = await mercadopago.payment.create(payment_data);
        return pagamento.body;
    } catch (error) {
        console.error("Erro ao criar pagamento:", error);
        return null;
    }
}

// ===== COMANDOS =====

// Start
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `🚀 Bem-vindo à Calculadora Pro!\n\n` +
        `Use /comprar para liberar acesso 🔓`
    );
});

// Comprar (gera PIX)
bot.onText(/\/comprar/, async (msg) => {
    const chatId = msg.chat.id;

    bot.sendMessage(chatId, "⏳ Gerando pagamento PIX...");

    const pagamento = await criarPagamento();

    if (!pagamento) {
        return bot.sendMessage(chatId, "❌ Erro ao gerar pagamento.");
    }

    const pixCopiaCola = pagamento.point_of_interaction.transaction_data.qr_code;

    bot.sendMessage(chatId,
        `💰 PAGAMENTO VIA PIX\n\n` +
        `💵 Valor: R$10,00\n\n` +
        `📲 Copie e cole no seu banco:\n\n` +
        `${pixCopiaCola}\n\n` +
        `⏱ Após o pagamento, a liberação será automática (em breve)`
    );
});

// ===== LOG =====
console.log("🤖 Bot rodando...");
