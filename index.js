const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Service Role Key
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').map(Number); // IDs de admins
const PORT = process.env.PORT || 10000;

if (!TELEGRAM_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !MP_ACCESS_TOKEN) {
    console.error("❌ ERRO: Variáveis de ambiente não configuradas");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const mpPayment = new Payment(mpClient);

const app = express();
app.use(express.json());

// ===== FUNÇÕES AUXILIARES =====
function gerarDeviceId(msg) {
    return `${msg.chat.id}-${msg.from.username || 'anon'}`;
}

async function logSuspeito(chatId, tipo, descricao) {
    console.log(`⚠️ SUSPEITA: ${tipo} - ${descricao} (chat: ${chatId})`);
    await supabase.from('logs_suspeitos').insert([{ chat_id: chatId, tipo, descricao, data: new Date() }]);
}

async function verificarAcesso(usuario, msg) {
    const agora = new Date();
    if (!usuario || new Date(usuario.expires_at) < agora) {
        await logSuspeito(msg.chat.id, "ACESSO_NEGADO", "Tentativa de acessar comando sem acesso válido");
        bot.sendMessage(msg.chat.id, "🚫 Acesso inválido ou expirado.");
        return false;
    }
    if (usuario.status === "bloqueado") {
        await logSuspeito(msg.chat.id, "ACESSO_NEGADO", "Usuário bloqueado tentou acessar comando");
        bot.sendMessage(msg.chat.id, "🚫 Sua conta está bloqueada. Contate o suporte.");
        return false;
    }
    return true;
}

// ===== /start =====
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const deviceAtual = gerarDeviceId(msg);
    const ip = msg.ip || 'desconhecido';
    const agora = new Date();

    const { data: usuario } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).single();

    if (usuario) {
        if (usuario.device_id && usuario.device_id !== deviceAtual) {
            await logSuspeito(chatId, "MULTI-DEVICE", `Tentativa de start em outro device: ${deviceAtual}`);
            return bot.sendMessage(chatId, "🚫 Conta já está em outro dispositivo.\nFale com o suporte.");
        }
        if (usuario.last_ip && usuario.last_ip !== ip) {
            await logSuspeito(chatId, "MULTI-IP", `Tentativa de start de outro IP: ${ip}`);
            return bot.sendMessage(chatId, "🚫 Tentativa de acesso de outro IP detectada.\nFale com o suporte.");
        }
    }

    if (usuario && usuario.ja_usou_trial) {
        const diasRestantes = Math.ceil((new Date(usuario.expires_at) - agora) / 86400000);
        if (diasRestantes > 0) {
            return bot.sendMessage(chatId,
                `👋 Bem-vindo de volta!\n🎁 Você ainda tem *${diasRestantes} dias* de trial.\n💰 Depois: R$10`,
                { parse_mode: "Markdown" }
            );
        } else {
            await logSuspeito(chatId, "START_APÓS_TRIAL", "Tentativa de /start após expirar trial");
            return bot.sendMessage(chatId, "👋 Bem-vindo de volta!\n❌ Seu trial expirou.\n💰 Use /comprar para liberar acesso.");
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

    bot.sendMessage(chatId, "🎁 7 dias grátis liberados!\n💰 Depois: R$10");
});

// ===== /comprar =====
bot.onText(/\/comprar/, async (msg) => {
    const chatId = msg.chat.id;
    const { data: usuario } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).single();
    if (!usuario) return bot.sendMessage(chatId, "🚫 Use /start antes de comprar.");
    if (usuario.tentativas_pix >= 3) {
        await logSuspeito(chatId, "ERRO_PIX", "Tentativas PIX excedidas");
        return bot.sendMessage(chatId, "❌ Você já tentou gerar PIX 3 vezes. Contate o suporte.");
    }

    await supabase.from('usuarios').update({ tentativas_pix: usuario.tentativas_pix + 1 }).eq('chat_id', chatId);

    try {
        const paymentData = {
            transaction_amount: 10,
            description: "Assinatura Calculadora Pro",
            payment_method_id: "pix",
            payer: { email: `${msg.from.username || 'anon'}@example.com` },
            metadata: { chat_id: chatId.toString() } // melhoria: vincula pagamento ao chat_id
        };
        const result = await mpPayment.create({ body: paymentData });
        bot.sendMessage(chatId, `💰 PIX:\n${result.point_of_interaction.transaction_data.qr_code}\n📲 Pague e liberação automática.`);
    } catch (err) {
        console.log("❌ PAGAMENTO:", err);
        await logSuspeito(chatId, "ERRO_PIX", err.message);
        bot.sendMessage(chatId, "🚫 Erro ao gerar PIX. Tente novamente.");
    }
});

// ===== /assinatura =====
bot.onText(/\/assinatura/, async (msg) => {
    const chatId = msg.chat.id;
    const { data: usuario } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).single();
    if (await verificarAcesso(usuario, msg)) {
        bot.sendMessage(chatId, "✅ Acesso liberado!\n📊 Relatório completo disponível!");
    }
});

// ===== /admin =====
// ... (mantive igual ao seu, sem alterações)

// ===== Webhook Mercado Pago =====
app.post('/webhook', async (req, res) => {
    const { id, type } = req.body;
    if (type !== 'payment') return res.sendStatus(200);
    try {
        const result = await mpPayment.get({ id });
        const chatId = result.metadata?.chat_id; // melhoria: usa metadata.chat_id
        if (chatId) {
            const novaData = new Date();
            novaData.setMonth(novaData.getMonth() + 1);
            await supabase.from('usuarios').update({ status: "ativo", expires_at: novaData, tentativas_pix: 0 }).eq('chat_id', chatId);
            bot.sendMessage(chatId, "✅ Pagamento confirmado! Acesso liberado por 1 mês.");
        }
        res.sendStatus(200);
    } catch (err) {
        console.log("❌ WEBHOOK ERROR:", err);
        res.sendStatus(500);
    }
});

// ===== Start Express =====
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
