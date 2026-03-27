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
const PORT = parseInt(process.env.PORT || "10000", 10);

if (!TELEGRAM_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !MP_ACCESS_TOKEN) {
  console.error("Variaveis de ambiente obrigatorias nao definidas.");
  process.exit(1);
}

// ── Clients ──────────────────────────────────────────────────
const bot      = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app      = express();
app.use(express.json());

// Cache em memoria para QR codes PIX (payment_id -> qr_code string)
const pixCache = new Map();

// ── Helpers ──────────────────────────────────────────────────

const isAdmin = (chatId) => ADMIN_IDS.includes(String(chatId));

const futureDate = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
};

/**
 * Busca usuario no Supabase. Retorna null se nao existir.
 */
async function getUser(chatId) {
  const { data, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("chat_id", String(chatId))
    .maybeSingle();

  if (error) {
    console.error("[getUser] Supabase error:", JSON.stringify(error));
    throw new Error(error.message || JSON.stringify(error));
  }
  return data;
}

/**
 * Cria novo usuario no Supabase.
 */
async function createUser(chatId, deviceId, ip) {
  const { data, error } = await supabase
    .from("usuarios")
    .insert({
      chat_id:        String(chatId),
      status:         "trial",
      trial_expira:   futureDate(7),
      tentativas_pix: 0,
      device_id:      deviceId || null,
      ip:             ip || null,
      bloqueado:      false,
      criado_em:      new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error("[createUser] Supabase error:", JSON.stringify(error));
    throw new Error(error.message || JSON.stringify(error));
  }
  return data;
}

/**
 * Verifica se o usuario tem acesso ativo.
 */
async function verificarAcesso(chatId) {
  let user;
  try {
    user = await getUser(chatId);
  } catch (e) {
    return { ok: false, motivo: "Erro ao consultar banco: " + e.message };
  }

  if (!user)           return { ok: false, motivo: "Usuario nao encontrado. Use /start." };
  if (user.bloqueado)  return { ok: false, motivo: "Sua conta esta bloqueada. Fale com o suporte." };
  if (user.status === "ativo") return { ok: true, motivo: "Acesso ativo (assinatura paga)." };

  if (user.status === "trial") {
    const expira = new Date(user.trial_expira);
    if (expira > new Date()) {
      const dias = Math.ceil((expira - new Date()) / 86_400_000);
      return { ok: true, motivo: `Trial ativo - faltam ${dias} dia(s).` };
    }
    return { ok: false, motivo: "Seu trial expirou. Use /comprar para assinar." };
  }

  return { ok: false, motivo: "Sem acesso ativo." };
}

/**
 * Registra log suspeito. Nao lanca erro para nao interromper o fluxo.
 */
async function registrarLogSuspeito(chatId, tipo, detalhe) {
  const { error } = await supabase.from("logs_suspeitos").insert({
    chat_id:   String(chatId),
    tipo,
    detalhe,
    criado_em: new Date().toISOString(),
  });
  if (error) console.error("[logSuspeito]", error.message);
}

/**
 * Cria pagamento PIX no Mercado Pago.
 */
async function criarPIX(chatId) {
  const body = {
    transaction_amount: 10,
    description:        "CalculadoraPro - Assinatura mensal",
    payment_method_id:  "pix",
    payer: {
      email:          "usuario_" + chatId + "@calculadorapro.bot",
      first_name:     "Usuario",
      last_name:      "Bot",
      identification: { type: "CPF", number: "00000000000" },
    },
    external_reference: String(chatId),
  };

  const { data } = await axios.post(
    "https://api.mercadopago.com/v1/payments",
    body,
    {
      headers: {
        Authorization:       "Bearer " + MP_ACCESS_TOKEN,
        "Content-Type":      "application/json",
        "X-Idempotency-Key": "pix-" + chatId + "-" + Date.now(),
      },
    }
  );

  return {
    payment_id:     data.id,
    qr_code:        data.point_of_interaction &&
                    data.point_of_interaction.transaction_data &&
                    data.point_of_interaction.transaction_data.qr_code,
    qr_code_base64: data.point_of_interaction &&
                    data.point_of_interaction.transaction_data &&
                    data.point_of_interaction.transaction_data.qr_code_base64,
  };
}

// ── /start ───────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId   = msg.chat.id;
  const username = (msg.from && (msg.from.username || msg.from.first_name)) || "usuario";
  const deviceId = "tg_" + chatId;

  try {
    const existing = await getUser(chatId);

    if (existing) {
      if (existing.device_id && existing.device_id !== deviceId) {
        await registrarLogSuspeito(chatId, "multi_device",
          "device anterior: " + existing.device_id + " | novo: " + deviceId);
      }

      await bot.sendMessage(
        chatId,
        "Bem-vindo de volta, *" + username + "*!\n\nUse /assinatura para ver seu status.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    await createUser(chatId, deviceId, null);

    await bot.sendMessage(
      chatId,
      "Bem-vindo ao *CalculadoraPro*, " + username + "!\n\n" +
      "Seu *trial gratuito de 7 dias* foi ativado.\n\n" +
      "Comandos disponiveis:\n" +
      "/assinatura - ver status\n" +
      "/comprar - assinar por R$10/mes",
      { parse_mode: "Markdown" }
    );

  } catch (err) {
    console.error("[/start] ERRO:", err.message);
    await bot.sendMessage(chatId, "Erro ao iniciar: " + err.message);
  }
});

// ── /assinatura ──────────────────────────────────────────────
bot.onText(/\/assinatura/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const { ok, motivo } = await verificarAcesso(chatId);
    const icone = ok ? "Ativo" : "Inativo";
    await bot.sendMessage(chatId,
      icone + " - *Status da assinatura*\n\n" + motivo,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("[/assinatura]", err.message);
    await bot.sendMessage(chatId, "Erro ao verificar assinatura: " + err.message);
  }
});

// ── /comprar ─────────────────────────────────────────────────
bot.onText(/\/comprar/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    // Incrementa tentativas_pix de forma segura (sem rpc)
    const user = await getUser(chatId);
    if (user) {
      await supabase
        .from("usuarios")
        .update({ tentativas_pix: (user.tentativas_pix || 0) + 1 })
        .eq("chat_id", String(chatId));
    }

    await bot.sendMessage(chatId, "Gerando seu PIX de R$10,00...");

    const { payment_id, qr_code, qr_code_base64 } = await criarPIX(chatId);

    if (!qr_code) {
      await bot.sendMessage(chatId, "Nao foi possivel gerar o PIX. Tente novamente.");
      return;
    }

    // Armazena no cache ANTES de enviar
    pixCache.set(String(payment_id), qr_code);

    // Registra pagamento pendente
    await supabase.from("pagamentos").insert({
      chat_id:    String(chatId),
      payment_id: String(payment_id),
      status:     "pendente",
      valor:      10,
      criado_em:  new Date().toISOString(),
    });

    // Envia QR Code como imagem, se disponivel
    if (qr_code_base64) {
      try {
        const imgBuffer = Buffer.from(qr_code_base64, "base64");
        await bot.sendPhoto(chatId, imgBuffer, {
          caption:    "PIX de R$10,00 gerado! Escaneie o QR Code ou use o botao abaixo.",
          parse_mode: "Markdown",
        });
      } catch (imgErr) {
        console.error("[/comprar] Erro ao enviar imagem QR:", imgErr.message);
      }
    }

    // Envia codigo PIX com botao inline
    await bot.sendMessage(
      chatId,
      "Codigo PIX (toque para copiar):\n\n`" + qr_code + "`",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "Copiar codigo PIX", callback_data: "copiar_pix:" + payment_id },
          ]],
        },
      }
    );

  } catch (err) {
    console.error("[/comprar]", err.message);
    await bot.sendMessage(chatId, "Erro ao gerar PIX: " + err.message);
  }
});

// ── /admin ───────────────────────────────────────────────────
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) {
    await bot.sendMessage(chatId, "Acesso negado.");
    return;
  }

  await bot.sendMessage(chatId, "*Painel Admin - CalculadoraPro*", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Ver usuarios",    callback_data: "admin:listar_usuarios"    }],
        [{ text: "Bloquear usuario", callback_data: "admin:bloquear_prompt"  }],
        [{ text: "Liberar usuario",  callback_data: "admin:liberar_prompt"   }],
        [{ text: "Reset trial",      callback_data: "admin:reset_trial_prompt" }],
        [{ text: "Logs suspeitos",   callback_data: "admin:logs_suspeitos"   }],
      ],
    },
  });
});

// ── Callback query handler ───────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data || "";

  // ── Copiar PIX ──────────────────────────────────────────────
  if (data.startsWith("copiar_pix:")) {
    const paymentId = data.replace("copiar_pix:", "");
    const qrCode    = pixCache.get(paymentId);

    if (!qrCode) {
      await bot.answerCallbackQuery(query.id, {
        text:       "Codigo expirado. Gere um novo com /comprar.",
        show_alert: true,
      });
      return;
    }

    await bot.sendMessage(
      chatId,
      "Codigo PIX (toque para copiar):\n\n`" + qrCode + "`",
      { parse_mode: "Markdown" }
    );
    await bot.answerCallbackQuery(query.id, { text: "Codigo PIX enviado!" });
    return;
  }

  // ── Admin callbacks ─────────────────────────────────────────
  if (!isAdmin(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: "Acesso negado.", show_alert: true });
    return;
  }

  if (data === "admin:listar_usuarios") {
    await bot.answerCallbackQuery(query.id);
    try {
      const { data: usuarios, error } = await supabase
        .from("usuarios")
        .select("chat_id, status, trial_expira, bloqueado, tentativas_pix")
        .order("criado_em", { ascending: false })
        .limit(20);

      if (error) throw new Error(error.message);
      if (!usuarios || usuarios.length === 0) {
        await bot.sendMessage(chatId, "Nenhum usuario cadastrado ainda.");
        return;
      }

      const linhas = usuarios.map((u) =>
        "- `" + u.chat_id + "` - " + u.status + (u.bloqueado ? " [BLOQUEADO]" : "") + " | PIX: " + (u.tentativas_pix || 0)
      );
      await bot.sendMessage(
        chatId,
        "*Usuarios (ultimos 20):*\n\n" + linhas.join("\n"),
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await bot.sendMessage(chatId, "Erro: " + err.message);
    }
    return;
  }

  if (data === "admin:logs_suspeitos") {
    await bot.answerCallbackQuery(query.id);
    try {
      const { data: logs, error } = await supabase
        .from("logs_suspeitos")
        .select("*")
        .order("criado_em", { ascending: false })
        .limit(15);

      if (error) throw new Error(error.message);
      if (!logs || logs.length === 0) {
        await bot.sendMessage(chatId, "Nenhum log suspeito registrado.");
        return;
      }

      const linhas = logs.map((l) =>
        "[" + l.chat_id + "] " + l.tipo + ": " + l.detalhe
      );
      await bot.sendMessage(
        chatId,
        "*Logs suspeitos (ultimos 15):*\n\n" + linhas.join("\n\n")
      );
    } catch (err) {
      await bot.sendMessage(chatId, "Erro: " + err.message);
    }
    return;
  }

  // Prompts admin: bloquear / liberar / reset trial
  const promptActions = ["admin:bloquear_prompt", "admin:liberar_prompt", "admin:reset_trial_prompt"];
  if (promptActions.includes(data)) {
    await bot.answerCallbackQuery(query.id);
    const acao = data.split(":")[1];
    const textos = {
      bloquear_prompt:    "Envie o chat_id do usuario a bloquear:",
      liberar_prompt:     "Envie o chat_id do usuario a liberar:",
      reset_trial_prompt: "Envie o chat_id para resetar o trial (+7 dias):",
    };

    const promptMsg = await bot.sendMessage(chatId, textos[acao], {
      reply_markup: { force_reply: true },
    });

    const listener = async (reply) => {
      if (reply.chat.id !== chatId) return;
      if (!reply.reply_to_message || reply.reply_to_message.message_id !== promptMsg.message_id) return;

      bot.removeListener("message", listener);

      const targetId = reply.text && reply.text.trim();
      if (!targetId) {
        await bot.sendMessage(chatId, "Nenhum ID fornecido.");
        return;
      }

      try {
        if (acao === "bloquear_prompt") {
          const { error } = await supabase.from("usuarios").update({ bloqueado: true }).eq("chat_id", targetId);
          if (error) throw new Error(error.message);
          await bot.sendMessage(chatId, "Usuario `" + targetId + "` bloqueado.", { parse_mode: "Markdown" });

        } else if (acao === "liberar_prompt") {
          const { error } = await supabase.from("usuarios")
            .update({ bloqueado: false, status: "ativo" }).eq("chat_id", targetId);
          if (error) throw new Error(error.message);
          await bot.sendMessage(chatId, "Usuario `" + targetId + "` liberado.", { parse_mode: "Markdown" });

        } else if (acao === "reset_trial_prompt") {
          const { error } = await supabase.from("usuarios")
            .update({ status: "trial", trial_expira: futureDate(7), bloqueado: false })
            .eq("chat_id", targetId);
          if (error) throw new Error(error.message);
          await bot.sendMessage(chatId, "Trial de `" + targetId + "` resetado por 7 dias.", { parse_mode: "Markdown" });
        }
      } catch (err) {
        await bot.sendMessage(chatId, "Erro: " + err.message);
      }
    };

    bot.on("message", listener);
    return;
  }

  await bot.answerCallbackQuery(query.id);
});

// ── Webhook Mercado Pago ──────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    console.log("[webhook] recebido:", JSON.stringify(body));

    // MP pode enviar "data.id" ou "resource" com a URL contendo o ID
    let paymentId = body && body.data && body.data.id;
    if (!paymentId && body && body.resource) {
      const match = String(body.resource).match(/(\d+)$/);
      if (match) paymentId = match[1];
    }

    if (!paymentId) return res.sendStatus(200);

    const { data: mpData } = await axios.get(
      "https://api.mercadopago.com/v1/payments/" + paymentId,
      { headers: { Authorization: "Bearer " + MP_ACCESS_TOKEN } }
    );

    if (mpData.status !== "approved") return res.sendStatus(200);

    const chatId = mpData.external_reference;
    if (!chatId) return res.sendStatus(200);

    await supabase
      .from("pagamentos")
      .update({ status: "aprovado", atualizado_em: new Date().toISOString() })
      .eq("payment_id", String(paymentId));

    const expira = futureDate(30);
    await supabase
      .from("usuarios")
      .update({ status: "ativo", assinatura_expira: expira, bloqueado: false })
      .eq("chat_id", String(chatId));

    await bot.sendMessage(
      chatId,
      "*Pagamento confirmado!*\n\n" +
      "Assinatura do *CalculadoraPro* ativa por 30 dias.\n" +
      "Valida ate: " + new Date(expira).toLocaleDateString("pt-BR"),
      { parse_mode: "Markdown" }
    );

    console.log("[webhook] Pagamento " + paymentId + " aprovado para chat_id " + chatId);
    res.sendStatus(200);

  } catch (err) {
    console.error("[webhook] ERRO:", err.message);
    res.sendStatus(500);
  }
});

// Health check
app.get("/", (_req, res) => res.send("CalculadoraPro bot online"));

// ── Express listen ───────────────────────────────────────────
app.listen(PORT, () => console.log("Servidor Express na porta " + PORT));

// ── Error handling global ────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err.message);
});

console.log("CalculadoraPro bot iniciado com polling...");
