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
    let { data: usuario } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).single();

    if (!usuario) {
        usuario = { chat_id: chatId, tentativas_pix: 0 };
        await supabase.from('usuarios').insert([{
            chat_id: chatId,
            status: "pendente_pagamento",
            expires_at: new Date(),
            ja_usou_trial: true,
            tentativas_pix: 0
        }]);
    }

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
            metadata: { chat_id: chatId.toString() }
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
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    if (!ADMIN_IDS.includes(chatId)) return;

    const keyboard = {
        inline_keyboard: [
            [{ text: "👥 Ver usuários ativos", callback_data: "ADMIN_LIST_USERS" }],
            [{ text: "⚠️ Ver logs suspeitos", callback_data: "ADMIN_LIST_LOGS" }]
        ]
    };
    bot.sendMessage(chatId, "⚡ Menu de Admin:", { reply_markup: keyboard });
});

// ===== CALLBACKS DE ADMIN =====
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.from.id;
    const data = callbackQuery.data;
    if (!ADMIN_IDS.includes(chatId)) return;

    if (data === "ADMIN_LIST_USERS") {
        const { data: usuarios } = await supabase.from('usuarios').select('*');
        if (!usuarios || usuarios.length === 0) return bot.sendMessage(chatId, "❌ Nenhum usuário encontrado.");
        for (const u of usuarios) {
            const text = `👤 Usuário: ${u.chat_id}
Status: ${u.status}
Expira: ${u.expires_at}
Tentativas PIX: ${u.tentativas_pix}`;
            const keyboard = {
                inline_keyboard: [
                    [{ text: "🚫 Bloquear", callback_data: `BLOCK_${u.chat_id}` }],
                    [{ text: "✅ Liberar", callback_data: `UNBLOCK_${u.chat_id}` }],
                    [{ text: "🔄 Reset Trial", callback_data: `RESET_${u.chat_id}` }]
                ]
            };
            await bot.sendMessage(chatId, text, { reply_markup: keyboard });
        }
    }

    if (data === "ADMIN_LIST_LOGS") {
        const { data: logs } = await supabase
            .from('logs_suspeitos')
            .select('*')
            .limit(20)
            .order('data', { ascending: false });
        if (!logs
