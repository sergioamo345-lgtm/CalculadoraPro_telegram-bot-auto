"use strict";

const TelegramBot      = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const express          = require("express");
const axios            = require("axios");

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const ADMIN_IDS       = (process.env.ADMIN_IDS || "").split(",").map(id => id.trim()).filter(Boolean);
const PORT            = parseInt(process.env.PORT || "10000", 10);

if (!TELEGRAM_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !MP_ACCESS_TOKEN) {
  console.error("Variaveis de ambiente obrigatorias nao definidas.");
  process.exit(1);
}

const bot      = new TelegramBot(TELEGRAM_TOKEN, {
  polling: { params: { timeout: 10, allowed_updates: ["message", "callback_query"] } }
});
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app      = express();
app.use(express.json());

const BOT_START_TIME = Math.floor(Date.now() / 1000);
const pixCache       = new Map();

// ── Helpers ──────────────────────────────────────────────────

const isAdmin    = (chatId) => ADMIN_IDS.includes(String(chatId));
const futureDate = (days)   => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString(); };

async function getUser(chatId) {
  const { data, error } = await supabase
    .from("usuarios").select("*").eq("chat_id", String(chatId)).maybeSingle();
  if (error) throw new Error(error.message || JSON.stringify(error));
  return data;
}

async function createUser(chatId, deviceId) {
  const { data, error } = await supabase.from("usuarios").insert({
    chat_id:        String(chatId),
    status:         "trial",
    trial_expira:   futureDate(7),
    tentativas_pix: 0,
    device_id:      deviceId || null,
    ip:             null,
    bloqueado:      false,
    criado_em:      new Date().toISOString(),
  }).select().single();
  if (error) throw new Error(error.message || JSON.stringify(error));
  return data;
}

async function verificarAcesso(chatId) {
  let user;
  try { user = await getUser(chatId); } catch (e) { return { ok: false, motivo: "Erro banco: " + e.message }; }
  if (!user)          return { ok: false, motivo: "Usuario nao encontrado. Use /start." };
  if (user.bloqueado) return { ok: false, motivo: "Conta bloqueada. Fale com o suporte." };
  if (user.status === "ativo") return { ok: true, motivo: "Acesso ativo (assinatura paga)." };
  if (user.status === "trial") {
    const expira = new Date(user.trial_expira);
    if (expira > new Date()) {
      const dias = Math.ceil((expira - new Date()) / 86_400_000);
      return { ok: true, motivo: "Trial ativo - faltam " + dias + " dia(s)." };
    }
    return { ok: false, motivo: "Trial expirado. Use /comprar para assinar." };
  }
  return { ok: false, motivo: "Sem acesso ativo." };
}

async function registrarLogSuspeito(chatId, tipo, detalhe) {
  const { error } = await supabase.from("logs_suspeitos").insert({
    chat_id: String(chatId), tipo, detalhe, criado_em: new Date().toISOString()
  });
  if (error) console.error("[logSuspeito]", error.message);
}

async function criarPIX(chatId) {
  const { data } = await axios.post(
    "https://api.mercadopago.com/v1/payments",
    {
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
    },
    {
      headers: {
        Authorization:       "Bearer " + MP_ACCESS_TOKEN,
        "Content-Type":      "application/json",
        "X-Idempotency-Key": "pix-" + chatId + "-" + Date.now(),
      },
    }
  );
  return {
    payment_id: data.id,
    qr_code:    data.point_of_interaction?.transaction_data?.qr_code,
  };
}

// ── /start ───────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;

  const chatId   = msg.chat.id;
  const username = msg.from?.username || msg.from?.first_name || "usuario";
  const deviceId = "tg_" + chatId;

  try {
    const existing = await getUser(chatId);

    if (existing) {
      if (existing.device_id && existing.device_id !== deviceId) {
        await registrarLogSuspeito(chatId, "multi_device",
          "device anterior: " + existing.device_id + " | novo: " + deviceId);
      }
      await bot.sendMessage(chatId,
        "Bem-vindo de volta, *" + username + "*!\n\nUse /assinatura para ver seu status.",
        { parse_mode: "Markdown" });
      return;
    }

    await createUser(chatId, deviceId);

    await bot.sendMessage(chatId,
      "Bem-vindo ao *CalculadoraPro*, " + username + "!\n\n" +
      "Seu *trial gratuito de 7 dias* foi ativado.\n\n" +
      "Comandos disponiveis:\n" +
      "/assinatura - ver status\n" +
      "/comprar - assinar por R$10/mes",
      { parse_mode: "Markdown" });

  } catch (err) {
    console.error("[/start] ERRO:", err.message);
    await bot.sendMessage(chatId, "Erro ao iniciar: " + err.message);
  }
});

// ── /assinatura ──────────────────────────────────────────────
bot.onText(/\/assinatura/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;

  const chatId = msg.chat.id;
  try {
    const { ok, motivo } = await verificarAcesso(chatId);
    await bot.sendMessage(chatId,
      (ok ? "✅ *Acesso ativo*" : "❌ *Sem acesso*") + "\n\n" + motivo,
      { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[/assinatura]", err.message);
    await bot.sendMessage(chatId, "Erro ao verificar: " + err.message);
  }
});

// ── /comprar ─────────────────────────────────────────────────
bot.onText(/\/comprar/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;

  const chatId = msg.chat.id;
  try {
    const user = await getUser(chatId);
    if (user) {
      await supabase.from("usuarios")
        .update({ tentativas_pix: (user.tentativas_pix || 0) + 1 })
        .eq("chat_id", String(chatId));
    }

    await bot.sendMessage(chatId, "⏳ Gerando seu PIX...");

    const { payment_id, qr_code } = await criarPIX(chatId);

    if (!qr_code) {
      await bot.sendMessage(chatId, "Nao foi possivel gerar o PIX. Tente novamente.");
      return;
    }

    pixCache.set(String(payment_id), qr_code);

    await supabase.from("pagamentos").insert({
      chat_id:    String(chatId),
      payment_id: String(payment_id),
      status:     "pendente",
      valor:      10,
      criado_em:  new Date().toISOString(),
    });

    // Mensagem explicando o processo + codigo PIX + botao copiar
    await bot.sendMessage(chatId,
      "💰 *Assinatura CalculadoraPro – R$10,00*\n\n" +
      "Copie o codigo PIX abaixo e pague no seu banco:\n\n" +
      "`" + qr_code + "`\n\n" +
      "⚡ Assim que o pagamento for confirmado, seu acesso sera liberado imediatamente!",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "📋 Copiar codigo PIX", callback_data: "copiar_pix:" + payment_id },
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
  if (msg.date < BOT_START_TIME) return;

  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { await bot.sendMessage(chatId, "Acesso negado."); return; }

  await bot.sendMessage(chatId, "*Painel Admin - CalculadoraPro*", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "👥 Ver usuarios",     callback_data: "admin:listar_usuarios"    }],
        [{ text: "🚫 Bloquear usuario", callback_data: "admin:bloquear_prompt"    }],
        [{ text: "✅ Liberar usuario",  callback_data: "admin:liberar_prompt"     }],
        [{ text: "🔄 Reset trial",      callback_data: "admin:reset_trial_prompt" }],
        [{ text: "⚠️ Logs suspeitos",   callback_data: "admin:logs_suspeitos"     }],
      ],
    },
  });
});

// ── Callback query handler ───────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data || "";

  // Copiar PIX
  if (data.startsWith("copiar_pix:")) {
    const paymentId = data.replace("copiar_pix:", "");
    const qrCode    = pixCache.get(paymentId);
    if (!qrCode) {
      await bot.answerCallbackQuery(query.id, {
        text: "Codigo expirado. Use /comprar para gerar um novo.", show_alert: true
      });
      return;
    }
    await bot.sendMessage(chatId,
      "📋 *Codigo PIX (toque para copiar):*\n\n`" + qrCode + "`",
      { parse_mode: "Markdown" });
    await bot.answerCallbackQuery(query.id, { text: "Codigo copiado!" });
    return;
  }

  // Admin apenas
  if (!isAdmin(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: "Acesso negado.", show_alert: true });
    return;
  }

  if (data === "admin:listar_usuarios") {
    await bot.answerCallbackQuery(query.id);
    const { data: usuarios, error } = await supabase
      .from("usuarios").select("chat_id, status, trial_expira, bloqueado, tentativas_pix")
      .order("criado_em", { ascending: false }).limit(20);
    if (error || !usuarios?.length) {
      await bot.sendMessage(chatId, error ? "Erro: " + error.message : "Nenhum usuario cadastrado.");
      return;
    }
    const linhas = usuarios.map(u =>
      "- `" + u.chat_id + "` " + u.status + (u.bloqueado ? " [BLOQ]" : "") + " | PIX: " + (u.tentativas_pix || 0)
    );
    await bot.sendMessage(chatId, "*Usuarios (ultimos 20):*\n\n" + linhas.join("\n"), { parse_mode: "Markdown" });
    return;
  }

  if (data === "admin:logs_suspeitos") {
    await bot.answerCallbackQuery(query.id);
    const { data: logs, error } = await supabase
      .from("logs_suspeitos").select("*").order("criado_em", { ascending: false }).limit(15);
    if (error || !logs?.length) {
      await bot.sendMessage(chatId, error ? "Erro: " + error.message : "Nenhum log registrado.");
      return;
    }
    const linhas = logs.map(l => "[" + l.chat_id + "] " + l.tipo + ": " + l.detalhe);
    await bot.sendMessage(chatId, "*Logs suspeitos:*\n\n" + linhas.join("\n\n"), { parse_mode: "Markdown" });
    return;
  }

  const promptActions = ["admin:bloquear_prompt", "admin:liberar_prompt", "admin:reset_trial_prompt"];
  if (promptActions.includes(data)) {
    await bot.answerCallbackQuery(query.id);
    const acao = data.split(":")[1];
    const textos = {
      bloquear_prompt:    "Envie o chat_id do usuario a bloquear:",
      liberar_prompt:     "Envie o chat_id do usuario a liberar:",
      reset_trial_prompt: "Envie o chat_id para resetar o trial (+7 dias):",
    };

    const promptMsg = await bot.sendMessage(chatId, textos[acao], { reply_markup: { force_reply: true } });

    const listener = async (reply) => {
      if (reply.chat.id !== chatId) return;
      if (!reply.reply_to_message || reply.reply_to_message.message_id !== promptMsg.message_id) return;
      bot.removeListener("message", listener);

      const targetId = reply.text?.trim();
      if (!targetId) { await bot.sendMessage(chatId, "Nenhum ID fornecido."); return; }

      try {
        if (acao === "bloquear_prompt") {
          const { error } = await supabase.from("usuarios")
            .update({ bloqueado: true }).eq("chat_id", targetId);
          if (error) throw new Error(error.message);
          await bot.sendMessage(chatId, "🚫 Usuario `" + targetId + "` bloqueado.", { parse_mode: "Markdown" });

        } else if (acao === "liberar_prompt") {
          const { error } = await supabase.from("usuarios")
            .update({ bloqueado: false, status: "ativo", assinatura_expira: futureDate(30) })
            .eq("chat_id", targetId);
          if (error) throw new Error(error.message);
          await bot.sendMessage(chatId, "✅ Usuario `" + targetId + "` liberado por 30 dias.", { parse_mode: "Markdown" });
          try {
            await bot.sendMessage(targetId,
              "✅ *Seu acesso foi liberado!*\n\nBem-vindo ao *CalculadoraPro*. Valido por 30 dias.",
              { parse_mode: "Markdown" });
          } catch (_) {}

        } else if (acao === "reset_trial_prompt") {
          const { error } = await supabase.from("usuarios")
            .update({ status: "trial", trial_expira: futureDate(7), bloqueado: false })
            .eq("chat_id", targetId);
          if (error) throw new Error(error.message);
          await bot.sendMessage(chatId, "🔄 Trial de `" + targetId + "` resetado por 7 dias.", { parse_mode: "Markdown" });
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

    let paymentId = body?.data?.id;
    if (!paymentId && body?.resource) {
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

    await supabase.from("pagamentos")
      .update({ status: "aprovado", atualizado_em: new Date().toISOString() })
      .eq("payment_id", String(paymentId));

    const expira = futureDate(30);
    await supabase.from("usuarios")
      .update({ status: "ativo", assinatura_expira: expira, bloqueado: false })
      .eq("chat_id", String(chatId));

    await bot.sendMessage(chatId,
      "🎉 *Pagamento confirmado!*\n\n" +
      "✅ Seu acesso ao *CalculadoraPro* esta ativo por 30 dias.\n" +
      "📅 Valido ate: " + new Date(expira).toLocaleDateString("pt-BR"),
      { parse_mode: "Markdown" });

    console.log("[webhook] Pagamento " + paymentId + " aprovado para chat_id " + chatId);
    res.sendStatus(200);
  } catch (err) {
    console.error("[webhook] ERRO:", err.message);
    res.sendStatus(500);
  }
});

app.get("/", (_req, res) => res.send("CalculadoraPro bot online"));

app.listen(PORT, () => console.log("Servidor Express na porta " + PORT));

process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));
process.on("uncaughtException",  (err)    => console.error("uncaughtException:", err.message));

console.log("CalculadoraPro bot iniciado...");
