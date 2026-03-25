const TelegramBot = require('node-telegram-bot-api');
const mercadopago = require('mercadopago');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ===== VALIDAÇÃO =====
if (!TELEGRAM_TOKEN || !MP_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.log("❌ ERRO: Variáveis de ambiente não definidas");
    process.exit(1);
}

// ===== SUPABASE =====
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== EXPRESS =====
const app = express();
app.use(express.json());

// ===== BOT =====
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ===== MERCADO PAGO =====
mercadopago.configure({
    access_token: MP_TOKEN
});

console.log("✅ Mercado Pago OK");

// ===== FUNÇÃO PIX =====
async function criarPagamento(chatId) {
    const payment_data = {
        transaction_amount: 10.00,
        description: "Acesso Calculadora Pro",
        payment_method_id: "pix",
        payer: { email: "cliente@email.com" },
        metadata: {
            chat_id: chatId.toString()
        }
    };

    try {
        const pagamento = await mercadopago.payment.create(payment_data);

        const paymentId = pagamento.body.id;

        // salva no banco
        await supabase.from('pagamentos').insert([{
            id: paymentId,
            chat_id: chatId,
            status: "pending",
            valor: 10
        }]);

        return pagamento.body;

    } catch (error) {
        console.error("❌ ERRO AO CRIAR PAGAMENTO:", error);
        return null;
    }
}

// ===== BOT =====

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `🚀 Bem-vindo!\nUse /comprar para liberar acesso 🔓`
    );
});

bot.onText(/\/comprar/, async (msg) => {
    const chatId = msg.chat.id;

    bot.sendMessage(chatId, "⏳ Gerando PIX...");

    const pagamento = await criarPagamento(chatId);

    if (!pagamento) {
        return bot.sendMessage(chatId, "❌ Erro ao gerar pagamento.");
    }

    const pix = pagamento.point_of_interaction.transaction_data.qr_code;

    bot.sendMessage(chatId,
        `💰 PAGAMENTO VIA PIX\n\n` +
        `💵 Valor: R$10,00\n\n` +
        `📲 Copie e cole no seu banco:\n\n${pix}`
    );
});

// ===== WEBHOOK =====
app.post('/webhook', async (req, res) => {
    try {
        console.log("🔥 WEBHOOK:", req.body);

        if (req.body.type === "payment") {
            const paymentId = req.body.data.id;

            const pagamento = await mercadopago.payment.findById(paymentId);

            const status = pagamento.body.status;
            const valor = pagamento.body.transaction_amount;
            const chat_id = pagamento.body.metadata?.chat_id;

            console.log("STATUS:", status);

            if (status === "approved" && chat_id) {

                // Atualiza pagamento
                await supabase
                    .from('pagamentos')
                    .update({ status: "approved" })
                    .eq('id', paymentId);

                // Libera usuário
                const novaData = new Date();
                novaData.setDate(novaData.getDate() + 30);

                await supabase.from('usuarios').upsert({
                    chat_id,
                    status: "ativo",
                    plano: "mensal",
                    expires_at: novaData
                });

                // Mensagem no Telegram
                bot.sendMessage(chat_id,
                    "✅ Pagamento aprovado! Acesso liberado 🚀"
                );

                console.log("✅ USUÁRIO LIBERADO:", chat_id);
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

// 📊 LISTAR USUÁRIOS
app.get('/usuarios', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);

    const { data, error } = await supabase.from('usuarios').select('*');
    if (error) return res.status(500).send(error);

    res.json(data);
});

// 🔓 LIBERAR
app.post('/liberar', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);

    const { chat_id } = req.body;

    const novaData = new Date();
    novaData.setDate(novaData.getDate() + 30);

    await supabase.from('usuarios').upsert({
        chat_id,
        status: "ativo",
        plano: "manual",
        expires_at: novaData
    });

    res.send("ok");
});

// 🚫 BLOQUEAR
app.post('/bloquear', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);

    const { chat_id } = req.body;

    await supabase
        .from('usuarios')
        .update({ status: "bloqueado" })
        .eq('chat_id', chat_id);

    res.send("ok");
});

// 💰 FATURAMENTO
app.get('/faturamento', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);

    const { data, error } = await supabase
        .from('pagamentos')
        .select('*')
        .eq('status', 'approved');

    if (error) return res.status(500).send(error);

    let total = 0;
    data.forEach(p => total += Number(p.valor || 0));

    res.json({
        total,
        quantidade: data.length
    });
});

// ===== START =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("🚀 Servidor rodando na porta", PORT);
});
