"use strict";

const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

// ─────────────────────────────
// CONFIG
// ─────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",");
const PORT = process.env.PORT || 10000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();
app.use(express.json());

// BOT ADMIN
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ─────────────────────────────
// HELPERS
// ─────────────────────────────

const futureDate = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
};

function isAdmin(chatId) {
  return ADMIN_IDS.includes(String(chatId));
}

// ─────────────────────────────
// 🔐 REGISTER
// ─────────────────────────────

app.post("/register", async (req, res) => {
  try {
    const { email, senha, device_id } = req.body;

    if (!email || !senha || !device_id) {
      return res.json({ ok: false });
    }

    const { data, error } = await supabase.from("usuarios").insert({
      email,
      senha,
      device_id,
      status: "trial",
      trial_expira: futureDate(7),
      bloqueado: false
    }).select().single();

    if (error) return res.json({ ok: false, error: error.message });

    res.json({ ok: true, user_id: data.id });

  } catch {
    res.json({ ok: false });
  }
});

// ─────────────────────────────
// 🔑 LOGIN
// ─────────────────────────────

app.post("/login", async (req, res) => {
  try {
    const { email, senha, device_id } = req.body;

    const { data: user } = await supabase
      .from("usuarios")
      .select("*")
      .eq("email", email)
      .eq("senha", senha)
      .single();

    if (!user) return res.json({ ok: false });

    if (user.bloqueado) {
      return res.json({ ok: false, motivo: "bloqueado" });
    }

    // 🔥 ANTI COMPARTILHAMENTO
    if (!user.device_id) {
      await supabase.from("usuarios")
        .update({ device_id })
        .eq("id", user.id);

    } else if (user.device_id !== device_id) {
      return res.json({ ok: false, motivo: "outro_celular" });
    }

    res.json({ ok: true, user_id: user.id });

  } catch {
    res.json({ ok: false });
  }
});

// ─────────────────────────────
// 🔥 VALIDAÇÃO APP
// ─────────────────────────────

app.post("/assinatura", async (req, res) => {
  try {
    const { user_id, device_id } = req.body;

    const { data: user } = await supabase
      .from("usuarios")
      .select("*")
      .eq("id", user_id)
      .single();

    if (!user) return res.json({ ativo: false });

    if (user.bloqueado) return res.json({ ativo: false });

    const agora = new Date();
    let ativo = false;

    if (user.status === "ativo") {
      ativo = new Date(user.assinatura_expira) > agora;
    }

    if (user.status === "trial") {
      ativo = new Date(user.trial_expira) > agora;
    }

    if (!ativo) return res.json({ ativo: false });

    // 🔥 ANTI COMPARTILHAMENTO
    if (user.device_id !== device_id) {
      return res.json({ ativo: false });
    }

    res.json({ ativo: true });

  } catch {
    res.json({ ativo: false });
  }
});

// ─────────────────────────────
// 💰 PIX
// ─────────────────────────────

async function criarPIX(user_id) {
  const { data } = await axios.post(
    "https://api.mercadopago.com/v1/payments",
    {
      transaction_amount: 10,
      description: "Assinatura App",
      payment_method_id: "pix",
      payer: { email: "user@app.com" },
      external_reference: String(user_id),
    },
    {
      headers: {
        Authorization: "Bearer " + MP_ACCESS_TOKEN,
      },
    }
  );

  return {
    payment_id: data.id,
    qr_code: data.point_of_interaction?.transaction_data?.qr_code
  };
}

// ─────────────────────────────
// 💳 COMPRAR
// ─────────────────────────────

app.post("/comprar", async (req, res) => {
  try {
    const { user_id } = req.body;

    const { payment_id, qr_code } = await criarPIX(user_id);

    await supabase.from("pagamentos").insert({
      user_id,
      payment_id,
      status: "pendente",
      valor: 10
    });

    res.json({ pix_code: qr_code });

  } catch {
    res.json({ error: true });
  }
});

// ─────────────────────────────
// 🔔 WEBHOOK
// ─────────────────────────────

app.post("/webhook", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.sendStatus(200);

    const { data } = await axios.get(
      "https://api.mercadopago.com/v1/payments/" + paymentId,
      { headers: { Authorization: "Bearer " + MP_ACCESS_TOKEN } }
    );

    if (data.status !== "approved") return res.sendStatus(200);

    const user_id = data.external_reference;

    await supabase.from("usuarios")
      .update({
        status: "ativo",
        assinatura_expira: futureDate(30)
      })
      .eq("id", user_id);

    res.sendStatus(200);

  } catch {
    res.sendStatus(500);
  }
});

// ─────────────────────────────
// 🤖 ADMIN TELEGRAM
// ─────────────────────────────

// /admin
bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;

  if (!isAdmin(chatId)) {
    return bot.sendMessage(chatId, "Acesso negado");
  }

  bot.sendMessage(chatId,
    "Painel Admin:\n\n" +
    "/bloquear user_id\n" +
    "/liberar user_id\n" +
    "/usuarios"
  );
});

// bloquear
bot.onText(/\/bloquear (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const userId = match[1];

  await supabase.from("usuarios")
    .update({ bloqueado: true })
    .eq("id", userId);

  bot.sendMessage(chatId, "🚫 Bloqueado: " + userId);
});

// liberar
bot.onText(/\/liberar (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const userId = match[1];

  await supabase.from("usuarios")
    .update({
      bloqueado: false,
      status: "ativo",
      assinatura_expira: futureDate(30)
    })
    .eq("id", userId);

  bot.sendMessage(chatId, "✅ Liberado: " + userId);
});

// listar
bot.onText(/\/usuarios/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const { data } = await supabase
    .from("usuarios")
    .select("id, email, status, bloqueado")
    .limit(20);

  if (!data) return bot.sendMessage(chatId, "Sem usuários");

  const lista = data.map(u =>
    `${u.id}\n${u.email}\n${u.status} ${u.bloqueado ? "🚫" : "✅"}`
  ).join("\n\n");

  bot.sendMessage(chatId, lista);
});

// ─────────────────────────────
// SERVER
// ─────────────────────────────

app.get("/", (_, res) => res.send("SaaS rodando 🚀"));

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
