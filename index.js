// index.js
const TelegramBot = require('node-telegram-bot-api');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const express = require('express');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!TELEGRAM_TOKEN || !MP_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ ERRO: Variáveis de ambiente não configuradas");
    process.exit(1);
}

// ===== SUPABASE =====
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===== BOT =====
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ===== MERCADO PAGO =====
const client = new MercadoPagoConfig({
    accessToken: MP_TOKEN
});

console.log("✅ Mercado Pago configurado");

// ===== EXPRESS =====
const app = express();
app.use(express.json());

// ===== MENU =====
bot.setMyCommands([
  { command: '/start', description: 'Começar a usar o bot' },
  { command: '/comprar', description: 'Comprar assinatura 30 dias R$10' },
  { command: '/assinatura', description: 'Ver status da assinatura' }
]);

// ===== CRIAR PAGAMENTO =====
async function criarPagamento(chatId) {
    try {
        const payment = new Payment(client);

        const body = {
            transaction_amount: 10,
            description: "Acesso Calculadora Pro",
            payment_method_id: "pix",
            payer: {
                email: `user${chatId}@example.com`
            },
            metadata: {
                chat_id: chatId.toString()
            }
        };

        const result = await payment.create({ body });

        const paymentId = result.id;

        // SALVA COM PAYMENT_ID (IMPORTANTE)
        const { error } = await supabase.from('pagamentos').insert([{
            payment_id: paymentId,
            chat_id: chatId,
            status: "pending",
            valor: 10
        }]);

        if (error) console.error("❌ ERRO SUPABASE:", error);
        else console.log("✅ Pagamento salvo:", paymentId);

        return result;

    } catch (error) {
        console.error("❌ ERRO PIX:", error);
        return null;
    }
}

// ===== BOT =====

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

    if (!pagamento) {
        return bot.sendMessage(chatId, "❌ Erro ao gerar pagamento.");
    }

    const pix = pagamento.point_of_interaction.transaction_data.qr_code;

    bot.sendMessage(chatId,
        `💰 *PIX:*\n\`\`\`\n${pix}\n\`\`\``,
        { parse_mode: 'Markdown' }
    );

    QRCode.toDataURL(pix, (err, url) => {
        if (!err) {
            bot.sendPhoto(chatId, url, { caption: '📲 Escaneie para pagar' });
        }
    });
});

// /assinatura
bot.onText(/\/assinatura/, async (msg) => {
    const chatId = msg.chat.id;

    const { data: usuario } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    if (!usuario || usuario.status !== "ativo") {
        return bot.sendMessage(chatId, "❌ Sem assinatura ativa.");
    }

    const dias = Math.ceil(
        (new Date(usuario.expires_at) - new Date()) / (1000 * 60 * 60 * 24)
    );

    bot.sendMessage(chatId, `✅ Ativo\nDias restantes: ${dias}`);
});

// ===== WEBHOOK =====
app.post('/webhook', async (req, res) => {
    try {
        console.log("🔥 WEBHOOK:", req.body);

        if (req.body.type === "payment") {
            const paymentId = req.body.data.id;

            const payment = new Payment(client);
            const pagamento = await payment.get({ id: paymentId });

            const status = pagamento.status;
            const chat_id = pagamento.metadata?.chat_id;

            console.log("💰 Status:", status);

            // ATUALIZA PELO PAYMENT_ID (CORRETO)
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
                    plano: "mensal",
                    expires_at: novaData
                });

                console.log("✅ Usuário liberado:", chat_id);

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
const ADMIN_KEY = "123456";

app.get('/admin/usuarios', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    const { data } = await supabase.from('usuarios').select('*');
    res.json(data);
});

app.get('/admin/faturamento', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);

    const { data } = await supabase
        .from('pagamentos')
        .select('*')
        .eq('status', 'approved');

    let total = 0;
    data.forEach(p => total += Number(p.valor));

    res.json({ total, quantidade: data.length });
});

// ===== START =====
app.listen(process.env.PORT || 3000, () => {
    console.log("🚀 Servidor rodando");
});
