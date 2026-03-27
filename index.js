const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');

// ✅ NOVO SDK MERCADO PAGO
const { MercadoPagoConfig, Payment } = require('mercadopago');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL = process.env.BASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || '123456';

if (!TELEGRAM_TOKEN || !MP_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BASE_URL) {
    console.error("❌ ERRO: Variáveis de ambiente não configuradas");
    process.exit(1);
}

// ===== SUPABASE =====
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===== MERCADO PAGO =====
const client = new MercadoPagoConfig({
    accessToken: MP_TOKEN
});
const payment = new Payment(client);

// ===== EXPRESS =====
const app = express();
app.use(cors());
app.use(express.json());

// ===== TELEGRAM WEBHOOK =====
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
bot.setWebHook(`${BASE_URL}/telegram-webhook`);

app.post(`/telegram-webhook`, async (req, res) => {
    try {
        await bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (err) {
        console.error("❌ ERRO TELEGRAM:", err);
        res.sendStatus(500);
    }
});

// ===== COMANDOS =====
bot.setMyCommands([
    { command: '/start', description: 'Iniciar' },
    { command: '/comprar', description: 'Comprar acesso' },
    { command: '/assinatura', description: 'Ver status' }
]);

// /start
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `👋 Olá ${msg.from.first_name}!\n\n` +
        `🎁 Você tem 7 dias grátis\n\n` +
        `💰 Depois: R$10 por 30 dias\n\n` +
        `👉 Use /comprar`
    );
});

// ===== PAGAMENTO =====
async function criarPagamento(chatId) {
    try {
        const paymentData = {
            transaction_amount: 10,
            description: "Acesso Calculadora Pro",
            payment_method_id: "pix",
            payer: {
                email: `user${chatId}@gmail.com`
            },
            metadata: {
                chat_id: chatId.toString()
            },
            external_reference: `user_${chatId}_${Date.now()}`,
            notification_url: `${BASE_URL}/webhook`,
            additional_info: {
                items: [{
                    id: "assinatura",
                    title: "Plano 30 dias",
                    quantity: 1,
                    unit_price: 10
                }]
            }
        };

        const result = await payment.create({ body: paymentData });

        const paymentId = result.id;

        await supabase.from('pagamentos').insert([{
            payment_id: paymentId,
            chat_id: chatId,
            status: "pending",
            valor: 10
        }]);

        return result;

    } catch (err) {
        console.error("❌ ERRO PAGAMENTO:", err);
        return null;
    }
}

// /comprar
bot.onText(/\/comprar/, async (msg) => {
    const chatId = msg.chat.id;

    bot.sendMessage(chatId, "⏳ Gerando PIX...");

    const pagamento = await criarPagamento(chatId);

    if (!pagamento) {
        return bot.sendMessage(chatId, "❌ Erro ao gerar pagamento.");
    }

    const pix = pagamento.point_of_interaction?.transaction_data?.qr_code;

    if (!pix) {
        return bot.sendMessage(chatId, "❌ PIX não gerado.");
    }

    // 💬 MENSAGEM EXPLICATIVA (O QUE VOCÊ PEDIU)
    bot.sendMessage(chatId,
        `💰 *PIX:*\n\`\`\`\n${pix}\n\`\`\`\n\n` +
        `📲 Pague o PIX acima.\n\n` +
        `⚡ Assim que o pagamento for aprovado,\n` +
        `seu acesso será liberado automaticamente.`,
        { parse_mode: "Markdown" }
    );

    QRCode.toDataURL(pix, (err, url) => {
        if (!err) {
            bot.sendPhoto(chatId, url, {
                caption: "📷 Escaneie para pagar"
            });
        }
    });
});

// /assinatura
bot.onText(/\/assinatura/, async (msg) => {
    const chatId = msg.chat.id;

    const { data } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    if (!data) {
        return bot.sendMessage(chatId, "❌ Sem assinatura ativa.");
    }

    const dias = Math.ceil((new Date(data.expires_at) - new Date()) / 86400000);

    bot.sendMessage(chatId, `✅ Ativo\nDias restantes: ${dias}`);
});

// ===== WEBHOOK =====
app.post('/webhook', async (req, res) => {
    try {
        console.log("🔥 WEBHOOK:", req.body);

        const paymentId = req.body.data?.id;
        if (!paymentId) return res.sendStatus(200);

        const result = await payment.get({ id: paymentId });

        const status = result.status;
        const chat_id = result.metadata?.chat_id;

        await supabase
            .from('pagamentos')
            .update({ status })
            .eq('payment_id', paymentId);

        if (status === "approved" && chat_id) {

            const novaData = new Date();
            novaData.setDate(novaData.getDate() + 30);

            await supabase.from('usuarios').upsert({
                chat_id,
                status: "ativo",
                expires_at: novaData
            });

            bot.sendMessage(chat_id, "✅ Pagamento aprovado! Acesso liberado 🚀");
        }

        res.sendStatus(200);

    } catch (err) {
        console.error("❌ ERRO WEBHOOK:", err);
        res.sendStatus(500);
    }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🚀 Servidor rodando");
});
