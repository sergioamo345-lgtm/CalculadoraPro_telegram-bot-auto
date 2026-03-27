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
const ADMIN_KEY = process.env.ADMIN_KEY || '123456';
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || '').split(','); // IDs dos admins

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

// ===== REGISTRAR LOG SUSPEITO =====
async function logSuspeito(chatId, action, info) {
    await supabase.from('logs_suspeitos').insert([{
        chat_id: chatId,
        action,
        info,
        created_at: new Date()
    }]);
    // alerta admins
    for (const adminId of ADMIN_CHAT_IDS) {
        bot.sendMessage(adminId, `⚠️ SUSPEITA: ${action} - ${info} (chat: ${chatId})`);
    }
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
    if (data.device_id && data.device_id !== deviceAtual) {
        await logSuspeito(chatId, "DISPOSITIVO DIFERENTE", `Tentativa de acesso com device_id: ${deviceAtual}`);
        return false;
    }
    if (data.status !== "ativo") return false;
    if (new Date(data.expires_at) < new Date()) return false;

    return true;
}

// ===== COMANDOS =====
bot.setMyCommands([
    { command: '/start', description: 'Iniciar' },
    { command: '/comprar', description: 'Comprar acesso' },
    { command: '/assinatura', description: 'Ver status' },
    { command: '/relatorio', description: 'Relatório admin' } // novo comando
]);

// ===== /start =====
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const deviceAtual = gerarDeviceId(msg);
    const ip = msg.ip || 'desconhecido'; // se tiver IP do webhook

    const { data: usuario } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    if (usuario && usuario.device_id && usuario.device_id !== deviceAtual) {
        await logSuspeito(chatId, "MULTI-DEVICE", `Tentativa de start em outro device: ${deviceAtual}`);
        return bot.sendMessage(chatId,
            "🚫 Conta já está em outro dispositivo.\n\nFale com o suporte."
        );
    }

    if (usuario && usuario.ja_usou_trial) {
        return bot.sendMessage(chatId,
            `👋 Bem-vindo de volta!\n❌ Você já usou o teste grátis.\n💰 Use /comprar`
        );
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
        last_login: new Date()
    });

    bot.sendMessage(chatId, `🎁 7 dias grátis liberados!\n💰 Depois: R$10`);
});

// ===== PAGAMENTO =====
async function criarPagamento(chatId) {
    try {
        const { data: pagamentoAberto } = await supabase
            .from('pagamentos')
            .select('*')
            .eq('chat_id', chatId)
            .eq('status', 'pending')
            .single();

        if (pagamentoAberto) {
            await logSuspeito(chatId, "PIX REPETIDO", "Tentativa de gerar PIX enquanto outro está pendente");
            return null;
        }

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
            valor: 10,
            token: result.id + "_" + chatId
        }]);

        return result;

    } catch (err) {
        console.error("❌ PAGAMENTO:", err);
        await logSuspeito(chatId, "ERRO_PIX", err.message);
        return null;
    }
}

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

    const pagamento = await criarPagamento(chatId);

    if (!pagamento) {
        await supabase.from('usuarios')
            .update({ tentativas_pix: (usuario?.tentativas_pix || 0) + 1 })
            .eq('chat_id', chatId);
        return bot.sendMessage(chatId, "❌ Já existe PIX pendente ou erro ao gerar.");
    }

    const pix = pagamento.point_of_interaction?.transaction_data?.qr_code;

    if (!pix) return bot.sendMessage(chatId, "❌ PIX erro.");

    bot.sendMessage(chatId,
        `💰 *PIX:*\n\`\`\`\n${pix}\n\`\`\`\n📲 Pague o PIX\n⚡ Liberação automática após pagamento.`,
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
        await logSuspeito(chatId, "ACESSO_NEGADO", "Tentativa de acessar /assinatura sem acesso válido");
        return bot.sendMessage(chatId, "🚫 Acesso inválido ou expirado.");
    }

    const { data } = await supabase
        .from('usuarios')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    const dias = Math.ceil((new Date(data.expires_at) - new Date()) / 86400000);
    bot.sendMessage(chatId, `✅ Ativo\nDias restantes: ${dias}`);
});

// ===== /relatorio (ADMIN) =====
bot.onText(/\/relatorio/, async (msg) => {
    const chatId = msg.chat.id.toString();

    if (!ADMIN_CHAT_IDS.includes(chatId)) {
        return bot.sendMessage(chatId, "🚫 Você não tem permissão para acessar este comando.");
    }

    try {
        const { data: ativos } = await supabase
            .from('usuarios')
            .select('chat_id, expires_at')
            .gt('expires_at', new Date());

        const { data: expirados } = await supabase
            .from('usuarios')
            .select('chat_id, expires_at')
            .lte('expires_at', new Date());

        const { data: pendentes } = await supabase
            .from('pagamentos')
            .select('chat_id, payment_id')
            .eq('status', 'pending');

        let texto = "📊 *Relatório de Usuários*\n\n";

        texto += `✅ *Ativos:* ${ativos.length}\n`;
        ativos.forEach(u => {
            const dias = Math.ceil((new Date(u.expires_at) - new Date()) / 86400000);
            texto += `- ${u.chat_id} → ${dias} dias restantes\n`;
        });

        texto += `\n⏳ *Pagamentos Pendentes:* ${pendentes.length}\n`;
        pendentes.forEach(p => texto += `- ${p.chat_id} → pagamento pendente\n`);

        texto += `\n❌ *Expirados:* ${expirados.length}\n`;
        expirados.forEach(u => texto += `- ${u.chat_id}\n`);

        bot.sendMessage(chatId, texto, { parse_mode: "Markdown" });

    } catch (err) {
        console.error("❌ ERRO RELATORIO:", err);
        bot.sendMessage(chatId, "❌ Erro ao gerar relatório.");
    }
});

// ===== WEBHOOK =====
app.post('/webhook', async (req, res) => {
    try {
        const paymentId = req.body.data?.id || req.body.resource;
        if (!paymentId) return res.sendStatus(200);

        const result = await payment.get({ id: paymentId });
        const status = result.status;
        const chat_id = result.metadata?.chat_id;

        const { data: pagamentoAtual } = await supabase
            .from('pagamentos')
            .select('*')
            .eq('payment_id', paymentId)
            .single();

        if (!pagamentoAtual || pagamentoAtual.status === status) {
            return res.sendStatus(200);
        }

        await supabase
            .from('pagamentos')
            .update({ status })
            .eq('payment_id', paymentId);

        if (status === "approved" && chat_id) {
            const novaData = new Date();
            novaData.setDate(novaData.getDate() + 30);

            await supabase.from('usuarios')
                .update({
                    status: "ativo",
                    expires_at: novaData,
                    tentativas_pix: 0
                })
                .eq('chat_id', chat_id);

            bot.sendMessage(chat_id, `✅ Pagamento aprovado!\nAcesso liberado por 30 dias.`);
        }

        res.sendStatus(200);

    } catch (err) {
        console.error("❌ WEBHOOK:", err);
        res.sendStatus(500);
    }
});

// ===== INICIAR SERVIDOR =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
