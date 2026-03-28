"use strict";

const TelegramBot      = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const express          = require("express");
const axios            = require("axios");

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PORT            = parseInt(process.env.PORT || "10000", 10);

if (!TELEGRAM_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !MP_ACCESS_TOKEN) {
  console.error("Variaveis obrigatorias nao definidas.");
  process.exit(1);
}

const bot      = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app      = express();
app.use(express.json());

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const futureDate = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
};

async function getUser(chatId) {
  const { data, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("chat_id", String(chatId))
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

// ─────────────────────────────────────────────
// 🔥 VALIDAÇÃO + ANTI COMPARTILHAMENTO
// ─────────────────────────────────────────────

async function verificarAcesso(chatId, deviceId) {
  let user;

  try {
    user = await getUser(chatId);
  } catch (e) {
    return { ativo: false };
  }

  if (!user) return { ativo: false };

  // 🔥 BLOQUEADO
  if (user.bloqueado) {
    return { ativo: false, motivo: "bloqueado" };
  }

  const agora = new Date();
  let ativo = false;

  // 🔥 ASSINATURA
  if (user.status === "ativo") {
    const expira = new Date(user.assinatura_expira);
    ativo = expira > agora;
  }

  // 🔥 TRIAL
  if (user.status === "trial") {
    const expira = new Date(user.trial_expira);
    ativo = expira > agora;
  }

  if (!ativo) {
    return { ativo: false, motivo: "expirado" };
  }

  // 🔥 ANTI COMPARTILHAMENTO
  if (!user.device_id) {
    await supabase
      .from("usuarios")
      .update({ device_id: deviceId })
      .eq("chat_id", String(chatId));

  } else if (user.device_id !== deviceId) {

    await supabase.from("logs_suspeitos").insert({
      chat_id: String(chatId),
      tipo: "multi_device",
      detalhe: `Registrado: ${user.device_id} | Novo: ${deviceId}`,
      criado_em: new Date().toISOString()
    });

    return {
      ativo: false,
      motivo: "dispositivo_nao_autorizado"
    };
  }

  return {
    ativo: true,
    expira_em: user.assinatura_expira || user.trial_expira
  };
}

// ─────────────────────────────────────────────
// 📱 ROTA PARA APP ANDROID
// ─────────────────────────────────────────────

app.post("/assinatura", async (req, res) => {
  try {
    const { chat_id, device_id } = req.body;

    if (!chat_id || !device_id) {
      return res.json({
        ativo: false,
        motivo: "dados_invalidos"
      });
    }

    const result = await verificarAcesso(chat_id, device_id);

    res.json(result);

  } catch (err) {
    console.error("[/assinatura]", err.message);
    res.json({ ativo: false });
  }
});

// ─────────────────────────────────────────────
// 💰 GERAR PIX
// ─────────────────────────────────────────────

async function criarPIX(chatId) {
  const { data } = await axios.post(
    "https://api.mercadopago.com/v1/payments",
    {
      transaction_amount: 10,
      description: "CalculadoraPro - Assinatura",
      payment_method_id: "pix",
      payer: {
        email: "user_" + chatId + "@app.com",
      },
      external_reference: String(chatId),
    },
    {
      headers: {
        Authorization: "Bearer " + MP_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );

  return {
    payment_id: data.id,
    qr_code: data.point_of_interaction?.transaction_data?.qr_code,
  };
}

// ─────────────────────────────────────────────
// 💳 ROTA COMPRAR (APP)
// ─────────────────────────────────────────────

app.post("/comprar", async (req, res) => {
  try {
    const { chat_id } = req.body;

    if (!chat_id) {
      return res.status(400).json({ error: "chat_id obrigatorio" });
    }

    const { payment_id, qr_code } = await criarPIX(chat_id);

    await supabase.from("pagamentos").insert({
      chat_id: String(chat_id),
      payment_id: String(payment_id),
      status: "pendente",
      valor: 10,
      criado_em: new Date().toISOString(),
    });

    res.json({ pix_code: qr_code });

  } catch (err) {
    console.error("[/comprar]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 🔔 WEBHOOK MERCADO PAGO
// ─────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  try {
    let paymentId = req.body?.data?.id;

    if (!paymentId) return res.sendStatus(200);

    const { data } = await axios.get(
      "https://api.mercadopago.com/v1/payments/" + paymentId,
      { headers: { Authorization: "Bearer " + MP_ACCESS_TOKEN } }
    );

    if (data.status !== "approved") return res.sendStatus(200);

    const chatId = data.external_reference;

    // 🔥 ATUALIZA PAGAMENTO
    await supabase.from("pagamentos")
      .update({ status: "aprovado" })
      .eq("payment_id", String(paymentId));

    const expira = futureDate(30);

    // 🔥 LIBERA USUÁRIO
    await supabase.from("usuarios")
      .update({
        status: "ativo",
        assinatura_expira: expira,
        bloqueado: false
      })
      .eq("chat_id", String(chatId));

    res.sendStatus(200);

  } catch (err) {
    console.error("[webhook]", err.message);
    res.sendStatus(500);
  }
});

// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────

app.get("/", (_, res) => res.send("Servidor online"));
app.listen(PORT, () => console.log("Rodando na porta " + PORT));
