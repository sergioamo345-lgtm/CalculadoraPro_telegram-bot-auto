const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');

// ===== CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Service Role Key
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').filter(Boolean).map(Number); // IDs de admins
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
  return `${msg.chat.id}-${msg.from?.username || 'anon'}`;
}

async function logSuspeito(chatId, tipo, descricao, extra = {}) {
  console.log(`⚠️ SUSPEITA: ${tipo} - ${descricao} (chat: ${chatId})`, extra);
  try {
    await supabase.from('logs_suspeitos').insert([{
      chat_id: chatId,
      tipo,
      descricao,
      data: new Date(),
      ip: extra.ip || null,
      device_id: extra.device_id || null
    }]);
  } catch (err) {
    console.error("Erro ao gravar log_suspeitos:", err);
  }
}

async function verificarAcesso(usuario, msg) {
  const agora = new Date();
  if (!usuario) {
    await logSuspeito(msg.chat.id, "ACESSO_NEGADO", "Usuário não encontrado ao verificar acesso");
    return false;
  }
  if (usuario.status === "bloqueado") {
    await logSuspeito(msg.chat.id, "ACESSO_NEGADO", "Usuário bloqueado tentou acessar comando");
    return false;
  }
  if (usuario.expires_at && new Date(usuario.expires_at) < agora) {
    await logSuspeito(msg.chat.id, "ACESSO_NEGADO", "Trial/assinatura expirada");
    return false;
  }
  return true;
}

// ===== /start =====
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const deviceAtual = gerarDeviceId(msg);
    const ip = msg.ip || 'desconhecido';
    const agora = new Date();

    const { data: usuario, error } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).single();
    if (error && error.code !== 'PGRST116') {
      console.error("Erro ao buscar usuario:", error);
    }

    if (usuario) {
      if (usuario.device_id && usuario.device_id !== deviceAtual) {
        await logSuspeito(chatId, "MULTI-DEVICE", `Tentativa de start em outro device: ${deviceAtual}`, { ip, device_id: deviceAtual });
        return bot.sendMessage(chatId, "🚫 Conta já está em outro dispositivo. Fale com o suporte.");
      }
      if (usuario.last_ip && usuario.last_ip !== ip) {
        await logSuspeito(chatId, "MULTI-IP", `Tentativa de start de outro IP: ${ip}`, { ip, device_id: deviceAtual });
        return bot.sendMessage(chatId, "🚫 Tentativa de acesso de outro IP detectada. Fale com o suporte.");
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
        await logSuspeito(chatId, "START_APÓS_TRIAL", "Tentativa de /start após expirar trial", { ip, device_id: deviceAtual });
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

    return bot.sendMessage(chatId, "🎁 7 dias grátis liberados!\n💰 Depois: R$10");
  } catch (err) {
    console.error("/start error:", err);
  }
});

// ===== /comprar =====
bot.onText(/\/comprar/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    let { data: usuario, error } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).single();

    if (error && error.code !== 'PGRST116') {
      console.error("Erro ao buscar usuario:", error);
    }

    // Se não existir, cria registro básico
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

    if ((usuario.tentativas_pix || 0) >= 3) {
      await logSuspeito(chatId, "ERRO_PIX", "Tentativas PIX excedidas");
      return bot.sendMessage(chatId, "❌ Você já tentou gerar PIX 3 vezes. Contate o suporte.");
    }

    await supabase.from('usuarios').update({ tentativas_pix: (usuario.tentativas_pix || 0) + 1 }).eq('chat_id', chatId);

    try {
      const paymentData = {
        transaction_amount: 10,
        description: "Assinatura Calculadora Pro",
        payment_method_id: "pix",
        payer: { email: `${msg.from?.username || 'anon'}@example.com` },
        metadata: { chat_id: chatId.toString() }
      };
      const result = await mpPayment.create({ body: paymentData });
      const qr = result?.point_of_interaction?.transaction_data?.qr_code || result?.body?.point_of_interaction?.transaction_data?.qr_code;
      if (!qr) {
        console.warn("Resposta MP sem QR:", result);
        return bot.sendMessage(chatId, "🚫 Não foi possível gerar o PIX. Tente novamente mais tarde.");
      }

      // === BOTÃO DE COPIAR PIX ===
      const keyboard = {
        inline_keyboard: [
          [
            { text: "📋 Copiar PIX", url: `https://t.me/share/url?url=${encodeURIComponent(qr)}&text=PIX` }
          ]
        ]
      };

      return bot.sendMessage(chatId, `💰 PIX:\n${qr}\n📲 Pague e liberação automática.`, { reply_markup: keyboard });
    } catch (err) {
      console.log("❌ PAGAMENTO:", err);
      await logSuspeito(chatId, "ERRO_PIX", err.message || String(err));
      return bot.sendMessage(chatId, "🚫 Erro ao gerar PIX. Tente novamente.");
    }
  } catch (err) {
    console.error("/comprar error:", err);
  }
});

// ===== /assinatura =====
bot.onText(/\/assinatura/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const { data: usuario } = await supabase.from('usuarios').select('*').eq('chat_id', chatId).single();
    const ok = await verificarAcesso(usuario, msg);
    if (!ok) {
      return bot.sendMessage(chatId, "🚫 Acesso inválido ou expirado. Use /comprar para renovar.");
    }
    return bot.sendMessage(chatId, "✅ Acesso liberado!\n📊 Relatório completo disponível!");
  } catch (err) {
    console.error("/assinatura error:", err);
  }
});

// ===== /admin =====
bot.onText(/\/admin/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    if (!ADMIN_IDS.includes(chatId)) return;
    const keyboard = {
      inline_keyboard: [
        [{ text: "👥 Ver usuários", callback_data: "ADMIN_LIST_USERS" }],
        [{ text: "⚠️ Ver logs suspeitos", callback_data: "ADMIN_LIST_LOGS" }]
      ]
    };
    return bot.sendMessage(chatId, "⚡ Menu de Admin:", { reply_markup: keyboard });
  } catch (err) {
    console.error("/admin error:", err);
  }
});

// ===== CALLBACKS DE ADMIN =====
bot.on('callback_query', async (callbackQuery) => {
  const fromId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message?.message_id;
  try {
    if (!ADMIN_IDS.includes(fromId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: "Acesso negado." });
      return;
    }

    // LIST USERS
    if (data === "ADMIN_LIST_USERS") {
      const { data: usuarios } = await supabase.from('usuarios').select('*').order('chat_id', { ascending: true });
      if (!usuarios || usuarios.length === 0) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Nenhum usuário encontrado." });
        return;
      }
      await bot.answerCallbackQuery(callbackQuery.id);
      for (const u of usuarios) {
        const text = `👤 Usuário: ${u.chat_id}\nStatus: ${u.status}\nExpira: ${u.expires_at}\nTentativas PIX: ${u.tentativas_pix || 0}`;
        const keyboard = {
          inline_keyboard: [
            [
              { text: "🚫 Bloquear", callback_data: `BLOCK_${u.chat_id}` },
              { text: "✅ Liberar", callback_data: `UNBLOCK_${u.chat_id}` }
            ],
            [{ text: "🔄 Reset Trial", callback_data: `RESET_${u.chat_id}` }]
          ]
        };
        await bot.sendMessage(fromId, text, { reply_markup: keyboard });
      }
      return;
    }

    // LIST LOGS
    if (data === "ADMIN_LIST_LOGS") {
      const { data: logs } = await supabase.from('logs_suspeitos').select('*').limit(50).order('data', { ascending: false });
      if (!logs || logs.length === 0) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Nenhum log suspeito." });
        return;
      }
      let text = "⚠️ Últimos logs:\n";
      logs.forEach(l => {
        text += `${new Date(l.data).toLocaleString()} - ${l.tipo} - ${l.descricao}\n`;
      });
      await bot.answerCallbackQuery(callbackQuery.id);
      return bot.sendMessage(fromId, text);
    }

    // BLOCK / UNBLOCK / RESET via callbacks
    if (data.startsWith("BLOCK_")) {
      const userId = data.split("_")[1];
      await supabase.from('usuarios').update({ status: "bloqueado" }).eq('chat_id', userId);
      await supabase.from('admin_logs').insert([{ admin_id: fromId, acao: 'bloquear', alvo_chat_id: userId }]).catch(() => {});
      await bot.answerCallbackQuery(callbackQuery.id, { text: `Usuário ${userId} bloqueado.` });
      return bot.sendMessage(fromId, `🚫
