// index.js
const TelegramBot = require('node-telegram-bot-api');
const mercadopago = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!TELEGRAM_TOKEN || !MP_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ ERRO: Variáveis de ambiente não configuradas");
    process.exit(1);
}

// ===== SUPABASE =====
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== BOT COM POLLING =====
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ===== MERCADO PAGO =====
mercadopago.configure({ access_token: MP_TOKEN });
console.log("✅ Mercado Pago configurado");

// ===== MENU DO BOT =====
bot.setMyCommands([
  { command: '/start', description: 'Começar a usar o bot' },
  { command: '/comprar', description: 'Comprar assinatura 30 dias R$10' },
  { command: '/assinatura', description: 'Ver status da assinatura' },
  { command: '/ajuda', description: 'Precisa de ajuda?' }
]);

// ===== FUNÇÃO CRIAR PAGAMENTO PIX =====
async function criarPagamento(chatId) {
    try {
        const payment_data = {
            transaction_amount: 10.00,
            description: "Acesso Calculadora Pro",
            payment_method_id: "pix",
            payer: { email: `user${chatId}@example.com` },
            metadata: { chat_id: chatId.toString() }
        };

        const pagamento = await mercadopago.payment.create(payment_data);
        const paymentId = pagamento.body.id;

        const { error } = await supabase.from('pagamentos').insert([{
            id: paymentId,
            chat_id: chatId,
            status: "pending",
            valor: 10
        }]);

        if (error) console.error("❌ ERRO SUPABASE:", error);
        else console.log("✅ Pagamento salvo:", paymentId);

        return pagamento.body;
    } catch (error) {
        console.error("❌ ERRO PIX:", error);
        return null;
    }
}

// ===== COMANDOS DO BOT =====

// /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
        `👋 Olá *${msg.from.first_name}*!\n\n` +
        `Você tem *7 dias grátis* para testar o app.\n` +
        `Após o teste, será necessário assinar 30 dias por R$10 para continuar usando.\n\n` +
        `Use o menu abaixo para comprar, verificar assinatura ou pedir ajuda.`, 
        { parse_mode: 'Markdown' }
    );
});

// /ajuda
bot.onText(/\/ajuda/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
        '💡 Comandos disponíveis:\n' +
        '/start - Começar e entender teste grátis\n' +
        '/comprar - Comprar assinatura 30 dias R$10\n' +
        '/assinatura - Ver status da assinatura\n' +
        '/ajuda - Suporte rápido',
        { parse_mode: 'Markdown' }
    );
});

// /comprar
bot.onText(/\/comprar/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "⏳ Gerando PIX...");

    const pagamento = await criarPagamento(chatId);
    if (!pagamento) return bot.sendMessage(chatId, "❌ Erro ao gerar pagamento.");

    // PIX
    const pix = pagamento.point_of_interaction.transaction_data.qr_code;
    bot.sendMessage(chatId, `💰 *PIX para assinatura 30 dias:*\n\`\`\`\n${pix}\n\`\`\``, { parse_mode: 'Markdown' });

    // QR Code
    QRCode.toDataURL(pix, (err, url) => {
        if (err) return bot.sendMessage(chatId, '❌ Erro ao gerar QR Code. Use o código acima.');
        bot.sendPhoto(chatId, url, { caption: '📲 Escaneie o QR Code para pagar' });
    });

    // Link Mercado Pago
    const mpLink = `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${pagamento.id}`;
    bot.sendMessage(chatId, `💳 Ou clique aqui para pagar via Mercado Pago:\n${mpLink}`);
});

// /assinatura
bot.onText(/\/assinatura/, async (msg) => {
    const chatId = msg.chat.id;
    const { data: usuario, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    if (error || !usuario || usuario.status !== "ativo") {
        return bot.sendMessage(chatId, `❌ Sua assinatura expirou ou ainda não foi paga.\nUse /comprar para renovar.`, { parse_mode: 'Markdown' });
    }

    const diasRestantes = Math.ceil((new Date(usuario.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
    bot.sendMessage(chatId, `✅ Sua assinatura está ativa!\nFaltam *${diasRestantes} dias* para expirar.`, { parse_mode: 'Markdown' });
});
