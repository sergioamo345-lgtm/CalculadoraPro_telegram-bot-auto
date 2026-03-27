// bot.js
// Bot do Telegram - CalculadoraPro
// Dependências: node-telegram-bot-api, express, @supabase/supabase-js, mercadopago
// Funcionalidades: /start, /comprar, /assinatura, /admin, Webhook Mercado Pago
// Autor: Projeto CalculadoraPro

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const mercadopago = require('mercadopago');

// Variáveis de ambiente (Render já fornece)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
const PORT = process.env.PORT || 3000;

// Inicializa bot e serviços
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Instancia cliente Mercado Pago (novo SDK)
const mpClient = new mercadopago.MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const mpPayment = new mercadopago.Payment(mpClient);

const app = express();
app.use(express.json());

// Função auxiliar para registrar logs
async function registrarLog(tipo, mensagem, userId = null) {
  await supabase.from('logs').insert([{ tipo, mensagem, user_id: userId, created_at: new Date() }]);
}

// /start - cria registro com trial de 7 dias
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const deviceId = msg.from.id;
  const ip = msg.from?.ip || 'unknown';

  try {
    const { data: user } = await supabase.from('users').select('*').eq('id', chatId).single();
    if (!user) {
      await supabase.from('users').insert([{
        id: chatId,
        username: msg.from.username,
        trial_expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        device_id: deviceId,
        last_ip: ip,
        status: 'active'
      }]);
      bot.sendMessage(chatId, '✅ Bem-vindo! Você ganhou 7 dias de trial.');
    } else {
      bot.sendMessage(chatId, 'Você já possui registro.');
    }
  } catch (err) {
    await registrarLog('erro', `Erro no /start: ${err.message}`, chatId);
    bot.sendMessage(chatId, '❌ Ocorreu um erro ao registrar seu trial.');
  }
});

// /comprar - gera PIX via Mercado Pago
bot.onText(/\/comprar/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const { data: tentativas } = await supabase.from('pix_attempts').select('*').eq('user_id', chatId);
    if (tentativas && tentativas.length >= 3) {
      return bot.sendMessage(chatId, '❌ Limite de 3 tentativas atingido.');
    }

    const payment = await mpPayment.create({
      body: {
        transaction_amount: 10,
        description: 'Assinatura CalculadoraPro',
        payment_method_id: 'pix',
        payer: { email: `user${chatId}@example.com` }
      }
    });

    const pixCode = payment.point_of_interaction.transaction_data.qr_code;
    await supabase.from('pix_attempts').insert([{ user_id: chatId, created_at: new Date() }]);

    bot.sendMessage(chatId, '💳 Seu PIX foi gerado:', {
      reply_markup: {
        inline_keyboard: [[{ text: '📋 Copiar PIX', callback_data: `COPY_PIX_${pixCode}` }]]
      }
    });
  } catch (err) {
    await registrarLog('erro', `Erro no /comprar: ${err.message}`, chatId);
    bot.sendMessage(chatId, '❌ Erro ao gerar PIX.');
  }
});

// Callback para copiar PIX e ações de admin
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('COPY_PIX_')) {
    const pixCode = data.replace('COPY_PIX_', '');
    bot.sendMessage(chatId, `📋 Copie este código PIX:\n\n${pixCode}`);
  }

  if (ADMIN_IDS.includes(String(chatId))) {
    if (data.startsWith('BLOCK_')) {
      const userId = data.replace('BLOCK_', '');
      await supabase.from('users').update({ status: 'blocked' }).eq('id', userId);
      await registrarLog('admin', `Usuário ${userId} bloqueado`, chatId);
      bot.sendMessage(chatId, `Usuário ${userId} bloqueado.`);
    }
    if (data.startsWith('UNBLOCK_')) {
      const userId = data.replace('UNBLOCK_', '');
      await supabase.from('users').update({ status: 'active' }).eq('id', userId);
      await registrarLog('admin', `Usuário ${userId} liberado`, chatId);
      bot.sendMessage(chatId, `Usuário ${userId} liberado.`);
    }
    if (data.startsWith('RESET_TRIAL_')) {
      const userId = data.replace('RESET_TRIAL_', '');
      await supabase.from('users').update({ trial_expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }).eq('id', userId);
      await registrarLog('admin', `Trial resetado para ${userId}`, chatId);
      bot.sendMessage(chatId, `Trial resetado para ${userId}.`);
    }
  }
});

// /assinatura - verifica status
bot.onText(/\/assinatura/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const { data: user } = await supabase.from('users').select('*').eq('id', chatId).single();
    if (user && user.status === 'active') {
      bot.sendMessage(chatId, `✅ Sua assinatura está ativa até ${user.trial_expiration}`);
    } else {
      bot.sendMessage(chatId, '❌ Você não possui assinatura ativa.');
    }
  } catch (err) {
    await registrarLog('erro', `Erro no /assinatura: ${err.message}`, chatId);
    bot.sendMessage(chatId, '❌ Erro ao verificar assinatura.');
  }
});

// /admin - menu
bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(String(chatId))) return;

  bot.sendMessage(chatId, '⚙️ Menu Admin:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👥 Ver usuários', callback_data: 'ADMIN_USERS' }],
        [{ text: '🚨 Ver logs suspeitos', callback_data: 'ADMIN_LOGS' }]
      ]
    }
  });
});

// Webhook Mercado Pago
app.post('/webhook', async (req, res) => {
  const data = req.body;
  try {
    if (data.type === 'payment' && data.data && data.data.id) {
      const payment = await mpPayment.get({ id: data.data.id });
      if (payment.status === 'approved') {
        const chatId = payment.payer.email.match(/user(\d+)@/)[1];
        await supabase.from('users').update({ trial_expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }).eq('id', chatId);
        bot.sendMessage(chatId, '🎉 Pagamento confirmado! Sua assinatura foi liberada por 1 mês.');
      }
    }
    res.sendStatus(200);
  } catch (err) {
    await registrarLog('erro', `Erro no webhook: ${err.message}`);
    res.sendStatus(500);
  }
});

// Tratamento de exceções gerais
process.on('unhandledRejection', (reason) => {
  registrarLog('erro', `UnhandledRejection: ${reason}`);
});
process.on('uncaughtException', (err) => {
  registrarLog('erro', `UncaughtException: ${err.message}`);
});

// Inicia servidor Express
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
