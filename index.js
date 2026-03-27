const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');
const { MercadoPagoConfig, Payment } = require('mercadopago');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL = process.env.BASE_URL;

if (!TELEGRAM_TOKEN || !MP_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BASE_URL) {
    console.error("❌ ERRO: Variáveis de ambiente não configuradas");
    process.exit(1);
}

// ===== SUPABASE =====
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===== MERCADO PAGO =====
const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
const payment = new Payment(client);

// ===== EXPRESS =====
const app = express();
app.use(cors());
app.use(express.json());

// ===== TELEGRAM =====
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
bot.setWebHook(`${BASE_URL}/telegram-webhook`);

app.post('/telegram-webhook', async (req, res) => {
    try {
        await bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (err) {
        console.error("❌ TELEGRAM:", err);
        res.sendStatus(500);
    }
});

// ===== DEVICE ID =====
function gerarDeviceId(msg) {
    return `${msg.from.id}_${msg.from.username || "no_user"}`;
}

// ===== VERIFICAR ACESSO =====
async function verificarAcesso(chatId, msg) {
    const deviceAtual = gerarDeviceId(msg);

    const { data } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    if (!data) return false;

    if (data.device_id && data.device_id !== deviceAtual) return false;

    if (data.status !== "ativo") return false;

    if (new Date(data.expires_at) < new Date()) return false;

    return true;
}

// ===== COMANDOS =====
bot.setMyCommands([
    { command: '/start', description: 'Iniciar' },
    { command: '/comprar', description: 'Comprar acesso' },
    { command: '/assinatura', description: 'Ver status' }
]);

// ===== /start =====
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const deviceAtual = gerarDeviceId(msg);

    const { data: usuario } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    // 🚫 BLOQUEIO POR DISPOSITIVO
    if (usuario && usuario.device_id && usuario.device_id !== deviceAtual) {
        return bot.sendMessage(chatId,
            "🚫 Conta já está em outro dispositivo.\n\nFale com o suporte."
        );
    }

    // 🚫 já usou trial
    if (usuario && usuario.ja_usou_trial) {
        return bot.sendMessage(chatId,
            `👋 Bem-vindo de volta!\n\n` +
            `❌ Você já usou o teste grátis.\n\n` +
            `💰 Use /comprar`
        );
    }

    // 🎁 liberar trial
    const novaData = new Date();
    novaData.setDate(novaData.getDate() + 7);

    await supabase.from('usuarios').upsert({
        chat_id: chatId,
        status: "ativo",
        expires_at: novaData,
        ja_usou_trial: true,
        device_id: deviceAtual
    });

    bot.sendMessage(chatId,
        `🎁 7 dias grátis liberados!\n\n💰 Depois: R$10`
    );
});

// ===== PAGAMENTO =====
async function criarPagamento(chatId) {
    try {
        const paymentData = {
            transaction_amount: 10,
            description: "Acesso Calculadora Pro",
            payment_method_id: "pix",
            payer: { email: `user${chatId}@gmail.com` },
            metadata: { chat_id: chatId.toString() },
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

        await supabase.from('pagamentos').insert([{
            payment_id: result.id,
            chat_id: chatId,
            status: "pending",
            valor: 10
        }]);

        return result;

    } catch (err) {
        console.error("❌ PAGAMENTO:", err);
        return null;
    }
}

// ===== /comprar =====
bot.onText(/\/comprar/, async (msg) => {
    const chatId = msg.chat.id;

    bot.sendMessage(chatId, "⏳ Gerando PIX...");

    const pagamento = await criarPagamento(chatId);

    if (!pagamento) return bot.sendMessage(chatId, "❌ Erro.");

    const pix = pagamento.point_of_interaction?.transaction_data?.qr_code;

    if (!pix) return bot.sendMessage(chatId, "❌ PIX erro.");

    bot.sendMessage(chatId,
        `💰 *PIX:*\n\`\`\`\n${pix}\n\`\`\`\n\n` +
        `📲 Pague o PIX\n\n` +
        `⚡ Liberação automática após pagamento.`,
        { parse_mode: "Markdown" }
    );

    QRCode.toDataURL(pix, (err, url) => {
        if (!err) bot.sendPhoto(chatId, url);
    });
});

// ===== /assinatura =====
bot.onText(/\/assinatura/, async (msg) => {
    const chatId = msg.chat.id;

    const acesso = await verificarAcesso(chatId, msg);

    if (!acesso) {
        return bot.sendMessage(chatId,
            "🚫 Acesso inválido ou expirado."
        );
    }

    const { data } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    const dias = Math.ceil((new Date(data.expires_at) - new Date()) / 86400000);

    bot.sendMessage(chatId, `✅ Ativo\nDias: ${dias}`);
});

// ===== WEBHOOK =====
app.post('/webhook', async (req, res) => {
    try {
        console.log("🔥 WEBHOOK:", req.body);

        const paymentId = req.body.data?.id || req.body.resource;

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
                expires_at: novaData,
                ja_usou_trial: true
            });

            bot.sendMessage(chat_id, "✅ Pagamento aprovado 🚀");
        }

        res.sendStatus(200);

    } catch (err) {
        console.error("❌ WEBHOOK:", err);
        res.sendStatus(500);
    }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🚀 Servidor rodando");
});
