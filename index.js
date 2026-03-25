// index.js atualizado
const TelegramBot = require('node-telegram-bot-api');
const mercadopago = require('mercadopago');
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TELEGRAM_TOKEN || !MP_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !WEBHOOK_URL) {
    console.error("❌ ERRO: Variáveis de ambiente não configuradas");
    process.exit(1);
}

// ===== SUPABASE =====
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== EXPRESS =====
const app = express();
app.use(bodyParser.json());

// ===== BOT =====
// 🚨 Sem polling, usando webhook
const bot = new TelegramBot(TELEGRAM_TOKEN);
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});
bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);

// ===== MERCADO PAGO =====
mercadopago.configure({ access_token: MP_TOKEN });
console.log("✅ Mercado Pago:", MP_TOKEN ? "OK" : "ERRO");

// ===== MENU DO BOT =====
bot.setMyCommands([
    { command: '/start', description: 'Começar e entender teste grátis' },
    { command: '/comprar', description: 'Comprar assinatura 30 dias R$10' },
    { command: '/assinatura', description: 'Verificar status da assinatura' },
    { command: '/ajuda', description: 'Instruções e suporte rápido' }
]);

// ===== FUNÇÃO PIX =====
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

        if (error) {
            console.error("❌ ERRO SUPABASE (insert pagamentos):", error);
        } else {
            console.log("✅ Pagamento salvo:", paymentId);
        }

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
    bot.sendMessage(chatId, "⏳ Gerando pagamento...");

    const pagamento = await criarPagamento(chatId);
    if (!pagamento) return bot.sendMessage(chatId, "❌ Erro ao gerar pagamento.");

    const linkPagamento = pagamento.point_of_interaction.transaction_data.ticket_url;

    // Envia link fácil de copiar
    bot.sendMessage(chatId, `💳 Para assinar 30 dias, clique ou copie o link abaixo:\n\`\`\`\n${linkPagamento}\n\`\`\``, { parse_mode: 'Markdown' });

    // Gera QR Code do link
    QRCode.toDataURL(linkPagamento, (err, url) => {
        if (err) return bot.sendMessage(chatId, '❌ Erro ao gerar QR Code. Use o link acima para pagar.');
        bot.sendPhoto(chatId, url, { caption: '📲 Escaneie o QR Code para pagar' });
    });
});

// /assinatura
bot.onText(/\/assinatura/, async (msg) => {
    const chatId = msg.chat.id;
    const { data, error } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).single();

    if (error || !data) {
        return bot.sendMessage(chatId, `❌ Nenhuma assinatura encontrada.\nUse /comprar para adquirir.`);
    }

    const hoje = new Date();
    const expiracao = new Date(data.expires_at);
    if (data.status === 'ativo' && expiracao > hoje) {
        const diasRestantes = Math.ceil((expiracao - hoje) / (1000*60*60*24));
        bot.sendMessage(chatId, `✅ Sua assinatura está ativa!\nFaltam *${diasRestantes} dias* para expirar.`, { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, `❌ Sua assinatura expirou ou ainda não foi paga.\nUse /comprar para renovar.`, { parse_mode: 'Markdown' });
    }
});

// ===== WEBHOOK MERCADO PAGO =====
app.post('/webhook', async (req, res) => {
    try {
        console.log("🔥 WEBHOOK recebido:", req.body);

        if (req.body.type === "payment") {
            const paymentId = req.body.data.id;
            const pagamento = await mercadopago.payment.findById(paymentId);
            const status = pagamento.body.status;
            const chat_id = pagamento.body.metadata?.chat_id;

            await supabase.from('pagamentos').update({ status }).eq('id', paymentId);

            if (status === "approved" && chat_id) {
                const novaData = new Date();
                novaData.setDate(novaData.getDate() + 30);

                await supabase.from('usuarios').upsert({
                    chat_id,
                    status: "ativo",
                    plano: "mensal",
                    expires_at: novaData
                });

                bot.sendMessage(chat_id, "✅ Pagamento aprovado! Acesso liberado 🚀");
            }
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("❌ ERRO WEBHOOK:", err);
        res.sendStatus(500);
    }
});

// ===== START SERVIDOR =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
