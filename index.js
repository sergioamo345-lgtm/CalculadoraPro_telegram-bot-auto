// index.js
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const mercadopago = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL = process.env.BASE_URL; // URL pública do Render (ex: https://seuapp.onrender.com)
const ADMIN_KEY = process.env.ADMIN_KEY || "123456";

if (!TELEGRAM_TOKEN || !MP_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BASE_URL) {
    console.error("❌ ERRO: Variáveis de ambiente não configuradas");
    process.exit(1);
}

// ===== SUPABASE =====
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===== MERCADO PAGO =====
const mp = new mercadopago({ access_token: MP_TOKEN });
console.log("✅ Mercado Pago configurado");

// ===== EXPRESS =====
const app = express();
app.use(cors());
app.use(express.json());

// ===== BOT TELEGRAM =====
const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${BASE_URL}/bot${TELEGRAM_TOKEN}`);
console.log("✅ Bot Telegram configurado via webhook");

// Comandos do bot
bot.setMyCommands([
  { command: '/start', description: 'Começar a usar o bot' },
  { command: '/comprar', description: 'Comprar assinatura 30 dias R$10' },
  { command: '/assinatura', description: 'Ver status da assinatura' }
]);

// ===== FUNÇÃO CRIAR PAGAMENTO =====
async function criarPagamento(chatId) {
    try {
        const body = {
            transaction_amount: 10,
            description: "Acesso Calculadora Pro",
            payment_method_id: "pix",
            payer: {
                email: `user${chatId}@example.com`
            },
            metadata: { chat_id: chatId.toString() }
        };

        const result = await mp.payment.create(body);
        const paymentId = result.body?.id;

        if (!paymentId) throw new Error("Pagamento não retornou ID válido");

        const { error } = await supabase.from('pagamentos').insert([{
            payment_id: paymentId,
            chat_id: chatId,
            status: "pending",
            valor: 10
        }]);

        if (error) console.error("❌ ERRO SUPABASE:", error);
        else console.log("✅ Pagamento salvo:", paymentId);

        return result.body;

    } catch (err) {
        console.error("❌ ERRO PIX:", err);
        return null;
    }
}

// ===== HANDLERS BOT =====

// /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
        `👋 Olá *${msg.from.first_name}*!\n\n` +
        `Você tem *7 dias grátis*.\nDepois disso: R$10 por 30 dias.\n\n` +
        `Use /comprar para liberar acesso.`,
        { parse_mode: 'Markdown' }
    );
});

// /comprar
bot.onText(/\/comprar/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "⏳ Gerando PIX...");
    const pagamento = await criarPagamento(chatId);

    if (!pagamento) return bot.sendMessage(chatId, "❌ Erro ao gerar pagamento.");

    const pix = pagamento.point_of_interaction?.transaction_data?.qr_code;
    if (!pix) return bot.sendMessage(chatId, "❌ Erro: PIX não gerado.");

    bot.sendMessage(chatId, `💰 *PIX:*\n\`\`\`\n${pix}\n\`\`\``, { parse_mode: 'Markdown' });
    QRCode.toDataURL(pix, (err, url) => {
        if (err) console.error("❌ Erro QRCode:", err);
        else bot.sendPhoto(chatId, url, { caption: '📲 Escaneie para pagar' });
    });
});

// /assinatura
bot.onText(/\/assinatura/, async (msg) => {
    const chatId = msg.chat.id;

    const { data: usuario, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    if (error) {
        console.error("❌ ERRO SUPABASE:", error);
        return bot.sendMessage(chatId, "❌ Erro ao verificar assinatura.");
    }

    if (!usuario || usuario.status !== "ativo") return bot.sendMessage(chatId, "❌ Sem assinatura ativa.");

    const expires = new Date(usuario.expires_at);
    if (isNaN(expires)) return bot.sendMessage(chatId, "❌ Data de expiração inválida.");

    const dias = Math.ceil((expires - new Date()) / (1000 * 60 * 60 * 24));
    bot.sendMessage(chatId, `✅ Ativo\nDias restantes: ${dias}`);
});

// ===== WEBHOOK MERCADO PAGO =====
app.post('/webhook', async (req, res) => {
    try {
        console.log("🔥 WEBHOOK:", req.body);

        if (req.body.type === "payment") {
            const paymentId = req.body.data.id;
            const pagamento = await mp.payment.get({ id: paymentId });
            const status = pagamento.body?.status;
            const chat_id = pagamento.body?.metadata?.chat_id;

            await supabase.from('pagamentos').update({ status }).eq('payment_id', paymentId);

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
        console.log("❌ ERRO WEBHOOK:", err);
        res.sendStatus(500);
    }
});

// ===== ADMIN =====
app.get('/admin/usuarios', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    const { data, error } = await supabase.from('usuarios').select('*');
    if (error) return res.status(500).json(error);
    res.json(data || []);
});

app.get('/admin/faturamento', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    const { data, error } = await supabase.from('pagamentos').select('*').eq('status', 'approved');
    if (error) return res.status(500).json(error);

    let total = 0;
    data.forEach(p => total += Number(p.valor));

    res.json({ total, quantidade: data.length });
});

// ===== TELEGRAM WEBHOOK =====
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// ===== START SERVIDOR =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando em ${PORT}`));
