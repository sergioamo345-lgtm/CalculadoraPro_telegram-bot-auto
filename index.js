const TelegramBot = require('node-telegram-bot-api');
const mercadopago = require('mercadopago');
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ===== VALIDAÇÃO =====
if (!TELEGRAM_TOKEN || !MP_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ ERRO: Variáveis de ambiente não configuradas");
    process.exit(1);
}

// ===== SUPABASE =====
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== EXPRESS =====
const app = express();
app.use(bodyParser.json());

// ===== BOT =====
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ===== MERCADO PAGO =====
mercadopago.configure({ access_token: MP_TOKEN });
console.log("✅ Mercado Pago:", MP_TOKEN ? "OK" : "ERRO");

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

        const { data, error } = await supabase.from('pagamentos').insert([{
            id: paymentId,
            chat_id: chatId,
            status: "pending",
            valor: 10
        }]);

        if (error) {
            console.error("❌ ERRO SUPABASE (insert pagamentos):", error);
        } else {
            console.log("✅ Pagamento salvo:", data);
        }

        return pagamento.body;
    } catch (error) {
        console.error("❌ ERRO PIX:", error);
        return null;
    }
}

// ===== ROTAS DO BOT =====
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "🚀 Bem-vindo!\nUse /comprar para liberar acesso 🔓");
});

bot.onText(/\/comprar/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "⏳ Gerando PIX...");

    const pagamento = await criarPagamento(chatId);
    if (!pagamento) return bot.sendMessage(chatId, "❌ Erro ao gerar pagamento.");

    const pix = pagamento.point_of_interaction.transaction_data.qr_code;
    bot.sendMessage(chatId, `💰 PAGAMENTO VIA PIX\n\n💵 Valor: R$10,00\n\n📲 Copie e cole:\n\n${pix}`);
});

// ===== WEBHOOK =====
app.post('/webhook', async (req, res) => {
    try {
        console.log("🔥 WEBHOOK recebido:", req.body);

        if (req.body.type === "payment") {
            const paymentId = req.body.data.id;
            const pagamento = await mercadopago.payment.findById(paymentId);

            const status = pagamento.body.status;
            const chat_id = pagamento.body.metadata?.chat_id;

            const { error: errUpdate } = await supabase
                .from('pagamentos')
                .update({ status })
                .eq('id', paymentId);

            if (errUpdate) {
                console.error("❌ ERRO SUPABASE (update pagamentos):", errUpdate);
            } else {
                console.log("✅ Pagamento atualizado:", paymentId, status);
            }

            if (status === "approved" && chat_id) {
                const novaData = new Date();
                novaData.setDate(novaData.getDate() + 30);

                const { error: errUser } = await supabase.from('usuarios').upsert({
                    chat_id,
                    status: "ativo",
                    plano: "mensal",
                    expires_at: novaData
                });

                if (errUser) {
                    console.error("❌ ERRO SUPABASE (upsert usuarios):", errUser);
                } else {
                    console.log("✅ Usuário liberado:", chat_id);
                }

                bot.sendMessage(chat_id, "✅ Pagamento aprovado! Acesso liberado 🚀");
            }
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("❌ ERRO WEBHOOK:", err);
        res.sendStatus(500);
    }
});

// ===== ADMIN =====
const ADMIN_KEY = "123456";

app.get('/usuarios', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    const { data, error } = await supabase.from('usuarios').select('*');
    if (error) {
        console.error("❌ ERRO SUPABASE (select usuarios):", error);
        return res.sendStatus(500);
    }
    res.json(data);
});

app.post('/liberar', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    const { chat_id } = req.body;

    const novaData = new Date();
    novaData.setDate(novaData.getDate() + 30);

    const { error } = await supabase.from('usuarios').upsert({
        chat_id,
        status: "ativo",
        plano: "manual",
        expires_at: novaData
    });

    if (error) {
        console.error("❌ ERRO SUPABASE (liberar usuario):", error);
        return res.sendStatus(500);
    }

    res.send("ok");
});

app.post('/bloquear', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    const { chat_id } = req.body;

    const { error } = await supabase.from('usuarios').update({ status: "bloqueado" }).eq('chat_id', chat_id);

    if (error) {
        console.error("❌ ERRO SUPABASE (bloquear usuario):", error);
        return res.sendStatus(500);
    }

    res.send("ok");
});

app.get('/faturamento', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    const { data, error } = await supabase.from('pagamentos').select('*').eq('status', 'approved');

    if (error) {
        console.error("❌ ERRO SUPABASE (faturamento):", error);
        return res.sendStatus(500);
    }

    let total = 0;
    data.forEach(p => total += Number(p.valor));

    res.json({ total, quantidade: data.length });
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
