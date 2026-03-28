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
const pixCache = new Map();

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
    bloqueado:      false,
    criado_em:      new Date().toISOString(),
  }).select().single();

  if (error) throw new Error(error.message || JSON.stringify(error));
  return data;
}

// 🔥 VALIDAÇÃO CENTRAL (AGORA COM DEVICE_ID)
async function verificarAcesso(chatId, deviceId) {
  const user = await getUser(chatId);

  if (!user) return { ativo: false };

  const agora = new Date();

  // 🔥 EXPIRAÇÃO
  let ativo = false;

  if (user.status === "ativo") {
    const expira = new Date(user.assinatura_expira);
    ativo = expira > agora;
  }

  if (user.status === "trial") {
    const expira = new Date(user.trial_expira);
    ativo = expira > agora;
  }

  if (!ativo) return { ativo: false };

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

// ── 🔥 NOVA ROTA PARA O APP ANDROID ───────────────────────────
app.post("/assinatura", async (req, res) => {
  try {
    const { chat_id, device_id } = req.body;

    if (!chat_id || !device_id) {
      return res.json({ ativo: false });
    }

    const result = await verificarAcesso(chat_id, device_id);

    res.json(result);

  } catch (err) {
    console.error("[/assinatura]", err.message);
    res.json({ ativo: false });
  }
});

// ── PIX ──────────────────────────────────────────────────────

async function criarPIX(chatId) {
  const { data } = await axios.post(
    "https://api.mercadopago.com/v1/payments",
    {
      transaction_amount: 10,
      description: "CalculadoraPro - Assinatura mensal",
      payment_method_id: "pix",
      payer: {
        email: "usuario_" + chatId + "@app.com",
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

// ── WEBHOOK ──────────────────────────────────────────────────

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

    const expira = futureDate(30);

    await supabase.from("usuarios")
      .update({
        status: "ativo",
        assinatura_expira: expira,
        bloqueado: false
      })
      .eq("chat_id", String(chatId));

    res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ── SERVER ───────────────────────────────────────────────────

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => console.log("Rodando na porta " + PORT));
