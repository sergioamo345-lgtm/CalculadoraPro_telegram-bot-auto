// ===== IMPORTS E CONFIG =====
const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const mercadopago = require('mercadopago');
const express = require('express');
const bodyParser = require('body-parser');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const BASE_URL = process.env.BASE_URL;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
mercadopago.configurations.setAccessToken(MP_TOKEN);

// ===== FUNÇÕES AUXILIARES =====
function gerarDeviceId(msg) {
    return `device_${msg.chat.id}_${msg.from.username || 'naoUser'}`;
}

async function logSuspeito(chatId, tipo, info) {
    console.log(`⚠️ SUSPEITA: ${tipo} - ${info} (chat: ${chatId})`);
}

// ===== /start =====
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const deviceAtual = gerarDeviceId(msg);
    const ip = msg.ip || 'desconhecido';

    const { data: usuario } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    if (usuario && usuario.device_id && usuario.device_id !== deviceAtual) {
        await logSuspeito(chatId, "MULTI-DEVICE", `Tentativa de start em outro device: ${deviceAtual}`);
        return bot.sendMessage(chatId, "🚫 Conta já está em outro dispositivo.\n\nFale com o suporte.");
    }

    const agora = new Date();

    if (usuario && usuario.ja_usou_trial) {
        const diasRestantes = Math.ceil((new Date(usuario.expires_at) - agora) / 86400000);
        if (diasRestantes > 0) {
            return bot.sendMessage(chatId,
                `👋 Bem-vindo de volta!\n🎁 Você ainda tem *${diasRestantes} dias* de trial.\n💰 Depois: R$10`,
                { parse_mode: "Markdown" }
            );
        } else {
            await logSuspeito(chatId, "START_APÓS_TRIAL", "Usuário tentou iniciar /start novamente após expirar o trial");
            return bot.sendMessage(chatId,
                `👋 Bem-vindo de volta!\n❌ Seu trial expirou.\n💰 Use /comprar para liberar acesso.`,
                { parse_mode: "Markdown" }
            );
        }
    }

    const novaData = new Date();
    novaData.setDate(novaData.getDate() + 7);

    await supabase.from('usuarios').upsert({
        chat_id: chatId,
        status: "ativo",
        expires_at: novaData,
        ja_usou_trial: true,
        device_id: deviceAtual,
        tentativas_pix: 0,
        last_ip: ip,
        last_login: agora
    });

    bot.sendMessage(chatId, `🎁 7 dias grátis liberados!\n💰 Depois: R$10`);
});

// ===== /comprar =====
bot.onText(/\/comprar/, async (msg) => {
    const chatId = msg.chat.id;

    const { data: usuario } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    if (usuario && usuario.tentativas_pix >= 3) {
        await logSuspeito(chatId, "LIMITE_PIX", "Usuário atingiu limite de tentativas");
        return bot.sendMessage(chatId, "🚫 Limite de tentativas de PIX atingido. Fale com o suporte.");
    }

    bot.sendMessage(chatId, "⏳ Gerando PIX...");

    try {
        const { data: pagamentoAberto } = await supabase
            .from('pagamentos')
            .select('*')
            .eq('chat_id', chatId)
            .eq('status', 'pending')
            .single();

        if (pagamentoAberto) {
            await logSuspeito(chatId, "PIX REPETIDO", "Tentativa de gerar PIX enquanto outro está pendente");
            return bot.sendMessage(chatId, "❌ Já existe PIX pendente. Aguarde aprovação.");
        }

        const paymentData = {
            transaction_amount: 10,
            description: "Acesso Calculadora Pro",
            payment_method_id: "pix",
            payer: {
                email: `user${chatId}@gmail.com`,
                first_name: msg.from.first_name
            },
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

        const result = await mercadopago.payment.create({ body: paymentData });

        await supabase.from('pagamentos').insert([{
            payment_id: result.id,
            chat_id: chatId,
            status: "pending",
            valor: 10,
            token: result.id + "_" + chatId
        }]);

        const pix = result.point_of_interaction?.transaction_data?.qr_code;
        if (!pix) return bot.sendMessage(chatId, "❌ Erro ao gerar PIX.");

        bot.sendMessage(chatId,
            `💰 PIX:\n\`\`\`\n${pix}\n\`\`\`\n📲 Pague o PIX\n⚡ Liberação automática após pagamento.`,
            { parse_mode: "Markdown" }
        );

        QRCode.toDataURL(pix, (err, url) => {
            if (!err) bot.sendPhoto(chatId, url);
        });

    } catch (err) {
        console.error("❌ PAGAMENTO:", err);
        await logSuspeito(chatId, "ERRO_PIX", err.message);

        await supabase.from('usuarios')
            .update({ tentativas_pix: (usuario?.tentativas_pix || 0) + 1 })
            .eq('chat_id', chatId);

        return bot.sendMessage(chatId, "❌ Já existe PIX pendente ou erro ao gerar.");
    }
});

// ===== /assinatura =====
bot.onText(/\/assinatura/, async (msg) => {
    const chatId = msg.chat.id;

    const { data: usuario } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    const agora = new Date();

    if (!usuario || new Date(usuario.expires_at) < agora) {
        await logSuspeito(chatId, "ACESSO_NEGADO", "Tentativa de acessar /assinatura sem acesso válido");
        return bot.sendMessage(chatId,
            "🚫 Acesso inválido ou expirado.\n💰 Use /comprar para liberar acesso."
        );
    }

    bot.sendMessage(chatId,
        `✅ Acesso ativo!\n🗓 Expira em: ${new Date(usuario.expires_at).toLocaleDateString()}`
    );
});

// ===== WEBHOOK MERCADO PAGO =====
const app = express();
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
    const data = req.body;

    if (data.type === "payment" && data?.data?.id) {
        const paymentId = data.data.id;

        try {
            const payment = await mercadopago.payment.get(paymentId);
            const chatId = payment.body.metadata.chat_id;

            if (payment.body.status === "approved") {
                // Libera acesso no Supabase
                const novaData = new Date();
                novaData.setDate(novaData.getDate() + 30);

                await supabase.from('usuarios').upsert({
                    chat_id: chatId,
                    status: "ativo",
                    expires_at: novaData,
                    ja_usou_trial: true
                });

                await supabase.from('pagamentos')
                    .update({ status: "approved" })
                    .eq('payment_id', paymentId);

                bot.sendMessage(chatId, `✅ Pagamento aprovado!\n🗓 Acesso liberado até: ${novaData.toLocaleDateString()}`);
            } else if (payment.body.status === "rejected") {
                await supabase.from('pagamentos')
                    .update({ status: "rejected" })
                    .eq('payment_id', paymentId);
            }

        } catch (err) {
            console.error("❌ ERRO WEBHOOK:", err);
        }
    }

    res.status(200).send('OK');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook rodando na porta ${PORT}`));
