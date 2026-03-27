// ============================================================
//  CalculadoraPro – Telegram Bot
//  Node.js 20+ | Render-ready
// ============================================================

"use strict";

// ── Imports ─────────────────────────────────────────────────
const TelegramBot      = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const express          = require("express");
const axios            = require("axios");

// ── Env vars ─────────────────────────────────────────────────
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const ADMIN_IDS       = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const PORT            = parseInt(process.env.PORT || "10000", 10);

if (!TELEGRAM_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !MP_ACCESS_TOKEN) {
  console.error("❌  Variáveis de ambiente obrigatórias não definidas.");
  process.exit(1);
}

// ── Clients ──────────────────────────────────────────────────
const bot     = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app      = express();
app.use(express.json());

// ── Helpers ──────────────────────────────────────────────────

/** Verifica se chat_id é admin */
const isAdmin = (chatId) => ADMIN_IDS.includes(String(chatId));

/** Retorna a data atual + dias */
const futureDate = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
};

/**
 * Busca ou cria usuário no Supabase.
 * @param {string|number} chatId
 * @param {object}        extra   – campos opcionais para upsert
 */
async function getOrCreateUser(chatId, extra = {}) {
  const { data, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("chat_id", String(chatId))
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const newUser = {
    chat_id:         String(chatId),
    status:          "trial",
    trial_expira:    futureDate(7),
    tentativas_pix:  0,
    device_id:       extra.device_id || null,
    ip:              extra.ip        || null,
    criado_em:       new Date().toISOString(),
  };

  const { data: created, error: err2 } = await supabase
    .from("usuarios")
    .insert(newUser)
    .select()
    .single();

  if (err2) throw err2;
  return created;
}

/**
 * Verifica se o usuário tem acesso ativo.
 * @returns {{ ok: boolean, motivo: string }}
 */
async function verificarAcesso(chatId) {
  const { data: user, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("chat_id", String(chatId))
    .maybeSingle();

  if (error || !user) return { ok: false, motivo: "Usuário não encontrado. Use /start." };
  if (user.bloqueado)  return { ok: false, motivo: "Sua conta está bloqueada. Fale com o suporte." };

  if (user.status === "ativo") return { ok: true, motivo: "Acesso ativo (assinatura paga)." };

  if (user.status === "trial") {
    const expira = new Date(user.trial_expira);
    if (expira > new Date()) {
      const dias = Math.ceil((expira - new Date()) / 86_400_000);
      return { ok: true, motivo: `Trial ativo – faltam ${dias} dia(s).` };
    }
    return { ok: false, motivo: "Seu trial expirou. Use /comprar para assinar." };
  }

  return { ok: false, motivo: "Sem acesso ativo." };
}

/**
 * Registra log suspeito.
 */
async function registrarLogSuspeito(chatId, tipo, detalhe) {
  await supabase.from("logs_suspeitos").insert({
    chat_id:    String(chatId),
    tipo,
    detalhe,
    criado_em:  new Date().toISOString(),
  });
}

/**
 * Cria pagamento PIX no Mercado Pago.
 * @returns {{ qr_code, qr_code_base64, payment_id }}
 */
async function criarPIX(chatId) {
  const body = {
    transaction_amount: 10,
    description:        "CalculadoraPro – Assinatura mensal",
    payment_method_id:  "pix",
    payer: {
      email:            `usuario_${chatId}@calculadorapro.bot`,
      first_name:       "Usuario",
      last_name:        "Bot",
      identification: { type: "CPF", number: "00000000000" },
    },
    external_reference: String(chatId),
  };

  const { data } = await axios.post(
    "https://api.mercadopago.com/v1/payments",
    body,
    {
      headers: {
        Authorization:  `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `pix-${chatId}-${Date.now()}`,
      },
    }
  );

  return {
    payment_id:      data.id,
    qr_code:         data.point_of_interaction?.transaction_data?.qr_code,
    qr_code_base64:  data.point_of_interaction?.transaction_data?.qr_code_base64,
  };
}

// ── /start ───────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId   = msg.chat.id;
  const username = msg.from?.username || "sem_user";

  // IP simulado (Telegram não expõe IP real; use um proxy reverso p/ obter)
  const fakeIp   = "0.0.0.0";
  const deviceId = `tg_${chatId}`;

  try {
    // Verifica se já existe
    const { data: existing } = await supabase
      .from("usuarios")
      .select("*")
      .eq("chat_id", String(chatId))
      .maybeSingle();

    if (existing) {
      // Checagem multi-device / multi-IP
      if (existing.device_id && existing.device_id !== deviceId) {
        await registrarLogSuspeito(chatId, "multi_device",
          `device anterior: ${existing.device_id} | novo: ${deviceId}`);
      }
      if (existing.ip && existing.ip !== fakeIp && fakeIp !== "0.0.0.0") {
        await registrarLogSuspeito(chatId, "multi_ip",
          `IP anterior: ${existing.ip} | novo: ${fakeIp}`);
      }

      await bot.sendMessage(chatId,
        `👋 Bem-vindo de volta, *${username}*!\n\nUse /assinatura para ver seu status.`,
        { parse_mode: "Markdown" });
      return;
    }

    // Cria novo usuário com trial de 7 dias
    await getOrCreateUser(chatId, { device_id: deviceId, ip: fakeIp });

    await bot.sendMessage(chatId,
      `🎉 Bem-vindo ao *CalculadoraPro*, ${username}!\n\n` +
      `✅ Seu *trial gratuito de 7 dias* foi ativado.\n\n` +
      `📌 Comandos disponíveis:\n` +
      `/assinatura – ver status\n` +
      `/comprar – assinar por R$10/mês\n`,
      { parse_mode: "Markdown" });

  } catch (err) {
    console.error("[/start]", err.message);
    await bot.sendMessage(chatId, "❌ Erro ao iniciar. Tente novamente.");
  }
});

// ── /assinatura ──────────────────────────────────────────────
bot.onText(/\/assinatura/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const { ok, motivo } = await verificarAcesso(chatId);
    const icone = ok ? "✅" : "❌";
    await bot.sendMessage(chatId, `${icone} *Status da assinatura*\n\n${motivo}`,
      { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[/assinatura]", err.message);
    await bot.sendMessage(chatId, "❌ Erro ao verificar assinatura.");
  }
});

// ── /comprar ─────────────────────────────────────────────────
bot.onText(/\/comprar/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    // Incrementa tentativas_pix
    await supabase
      .from("usuarios")
      .update({ tentativas_pix: supabase.rpc("increment", { x: 1 }) })
      .eq("chat_id", String(chatId));

    await bot.sendMessage(chatId, "⏳ Gerando seu PIX de R$10,00…");

    const { payment_id, qr_code, qr_code_base64 } = await criarPIX(chatId);

    if (!qr_code) {
      await bot.sendMessage(chatId, "❌ Não foi possível gerar o PIX. Tente novamente.");
      return;
    }

    // Registra pagamento pendente
    await supabase.from("pagamentos").insert({
      chat_id:    String(chatId),
      payment_id: String(payment_id),
      status:     "pendente",
      valor:      10,
      criado_em:  new Date().toISOString(),
    });

    // Envia QR Code (imagem base64 → buffer)
    if (qr_code_base64) {
      const imgBuffer = Buffer.from(qr_code_base64, "base64");
      await bot.sendPhoto(chatId, imgBuffer, {
        caption: `💸 *PIX de R$10,00 gerado!*\n\nEscaneie o QR Code ou copie o código abaixo 👇`,
        parse_mode: "Markdown",
      });
    }

    // Envia código PIX com botão inline "Copiar"
    await bot.sendMessage(chatId,
      `\`${qr_code}\``,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            {
              text:          "📋 Copiar código PIX",
              callback_data: `copiar_pix:${payment_id}`,
            },
          ]],
        },
      }
    );

    // Armazena qr_code temporariamente para callback
    pixCache.set(String(payment_id), qr_code);

  } catch (err) {
    console.error("[/comprar]", err.message);
    await bot.sendMessage(chatId, "❌ Erro ao gerar PIX. Tente novamente mais tarde.");
  }
});

// Cache em memória para QR codes (evita nova consulta ao MP)
const pixCache = new Map();

// ── /admin ───────────────────────────────────────────────────
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) {
    await bot.sendMessage(chatId, "⛔ Acesso negado.");
    return;
  }

  await bot.sendMessage(chatId, "🔧 *Painel Admin – CalculadoraPro*", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "👥 Ver usuários",         callback_data: "admin:listar_usuarios" }],
        [{ text: "🚫 Bloquear usuário",      callback_data: "admin:bloquear_prompt" }],
        [{ text: "✅ Liberar usuário",        callback_data: "admin:liberar_prompt"  }],
        [{ text: "🔄 Reset trial",            callback_data: "admin:reset_trial_prompt" }],
        [{ text: "⚠️ Logs suspeitos",         callback_data: "admin:logs_suspeitos"  }],
      ],
    },
  });
});

// ── Callback query handler ───────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId   = query.message.chat.id;
  const msgId    = query.message.message_id;
  const data     = query.data || "";

  // ── Copiar PIX ──────────────────────────────────────────────
  if (data.startsWith("copiar_pix:")) {
    const paymentId = data.split(":")[1];
    const qrCode    = pixCache.get(paymentId);

    if (!qrCode) {
      await bot.answerCallbackQuery(query.id, {
        text:       "⚠️ Código PIX não encontrado. Gere um novo com /comprar.",
        show_alert: true,
      });
      return;
    }

    // Envia como mensagem separada para o usuário copiar facilmente
    await bot.sendMessage(chatId,
      `📋 *Código PIX (toque para copiar):*\n\n\`${qrCode}\``,
      { parse_mode: "Markdown" });

    await bot.answerCallbackQuery(query.id, { text: "✅ Código PIX enviado!" });
    return;
  }

  // ── Admin callbacks ─────────────────────────────────────────
  if (!isAdmin(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: "⛔ Acesso negado.", show_alert: true });
    return;
  }

  if (data === "admin:listar_usuarios") {
    await bot.answerCallbackQuery(query.id);
    try {
      const { data: usuarios } = await supabase
        .from("usuarios")
        .select("chat_id, status, trial_expira, bloqueado, tentativas_pix")
        .order("criado_em", { ascending: false })
        .limit(20);

      if (!usuarios?.length) {
        await bot.sendMessage(chatId, "Nenhum usuário cadastrado.");
        return;
      }

      const linhas = usuarios.map((u) =>
        `• \`${u.chat_id}\` – ${u.status}${u.bloqueado ? " 🚫" : ""} | PIX: ${u.tentativas_pix}`
      );
      await bot.sendMessage(chatId,
        `👥 *Usuários (últimos 20):*\n\n${linhas.join("\n")}`,
        { parse_mode: "Markdown" });
    } catch (err) {
      await bot.sendMessage(chatId, `Erro: ${err.message}`);
    }
    return;
  }

  if (data === "admin:logs_suspeitos") {
    await bot.answerCallbackQuery(query.id);
    try {
      const { data: logs } = await supabase
        .from("logs_suspeitos")
        .select("*")
        .order("criado_em", { ascending: false })
        .limit(15);

      if (!logs?.length) {
        await bot.sendMessage(chatId, "Nenhum log suspeito registrado.");
        return;
      }

      const linhas = logs.map((l) =>
        `⚠️ \`${l.chat_id}\` – *${l.tipo}*\n   ${l.detalhe}`
      );
      await bot.sendMessage(chatId,
        `⚠️ *Logs suspeitos (últimos 15):*\n\n${linhas.join("\n\n")}`,
        { parse_mode: "Markdown" });
    } catch (err) {
      await bot.sendMessage(chatId, `Erro: ${err.message}`);
    }
    return;
  }

  // Prompts de ação (bloquear / liberar / reset) pedem ID via resposta
  if (["admin:bloquear_prompt", "admin:liberar_prompt", "admin:reset_trial_prompt"].includes(data)) {
    await bot.answerCallbackQuery(query.id);
    const acao = data.split(":")[1];
    const textos = {
      bloquear_prompt:    "🚫 Digite o chat_id do usuário a *bloquear*:",
      liberar_prompt:     "✅ Digite o chat_id do usuário a *liberar*:",
      reset_trial_prompt: "🔄 Digite o chat_id para *resetar o trial* (+ 7 dias):",
    };
    await bot.sendMessage(chatId, textos[acao], {
      parse_mode: "Markdown",
      reply_markup: { force_reply: true },
    });

    // Aguarda resposta do admin
    bot.once("message", async (reply) => {
      if (reply.chat.id !== chatId) return;
      const targetId = reply.text?.trim();
      if (!targetId) return;

      try {
        if (acao === "bloquear_prompt") {
          await supabase.from("usuarios").update({ bloqueado: true }).eq("chat_id", targetId);
          await bot.sendMessage(chatId, `🚫 Usuário \`${targetId}\` bloqueado.`, { parse_mode: "Markdown" });

        } else if (acao === "liberar_prompt") {
          await supabase.from("usuarios").update({ bloqueado: false, status: "ativo" }).eq("chat_id", targetId);
          await bot.sendMessage(chatId, `✅ Usuário \`${targetId}\` liberado.`, { parse_mode: "Markdown" });

        } else if (acao === "reset_trial_prompt") {
          await supabase.from("usuarios")
            .update({ status: "trial", trial_expira: futureDate(7), bloqueado: false })
            .eq("chat_id", targetId);
          await bot.sendMessage(chatId, `🔄 Trial de \`${targetId}\` resetado por mais 7 dias.`, { parse_mode: "Markdown" });
        }
      } catch (err) {
        await bot.sendMessage(chatId, `Erro: ${err.message}`);
      }
    });
    return;
  }

  await bot.answerCallbackQuery(query.id);
});

// ── Webhook Mercado Pago ──────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type !== "payment") {
      return res.sendStatus(200);
    }

    const paymentId = data?.id;
    if (!paymentId) return res.sendStatus(200);

    // Consulta o pagamento no MP
    const { data: mpData } = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    if (mpData.status !== "approved") return res.sendStatus(200);

    const chatId = mpData.external_reference;
    if (!chatId) return res.sendStatus(200);

    // Atualiza pagamento no Supabase
    await supabase
      .from("pagamentos")
      .update({ status: "aprovado", atualizado_em: new Date().toISOString() })
      .eq("payment_id", String(paymentId));

    // Libera acesso
    const expira = futureDate(30);
    await supabase
      .from("usuarios")
      .update({ status: "ativo", assinatura_expira: expira, bloqueado: false })
      .eq("chat_id", String(chatId));

    // Notifica usuário
    await bot.sendMessage(chatId,
      `🎉 *Pagamento confirmado!*\n\n` +
      `✅ Sua assinatura do *CalculadoraPro* está ativa por 30 dias.\n` +
      `📅 Válida até: ${new Date(expira).toLocaleDateString("pt-BR")}`,
      { parse_mode: "Markdown" });

    console.log(`[webhook] Pagamento ${paymentId} aprovado para chat_id ${chatId}`);
    res.sendStatus(200);

  } catch (err) {
    console.error("[webhook]", err.message);
    res.sendStatus(500);
  }
});

// Health check
app.get("/", (_req, res) => res.send("CalculadoraPro bot online ✅"));

// ── Express listen ───────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Servidor Express na porta ${PORT}`));

// ── Error handling global ────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("💥 uncaughtException:", err.message);
});

console.log("🤖 CalculadoraPro bot iniciado com polling…");
