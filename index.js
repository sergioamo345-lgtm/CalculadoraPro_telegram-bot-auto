require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.JWT_SECRET;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://calculadorapro-telegram-bot-auto.onrender.com';

app.get('/', (req, res) => {
  res.send('API ONLINE 🚀');
});

// 🔐 MIDDLEWARE
function autenticar(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ ok: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user_id = decoded.user_id;
    next();
  } catch {
    return res.status(401).json({ ok: false });
  }
}

// 🔁 REGISTER
app.post('/register', async (req, res) => {
  try {
    const { email, senha, device_id } = req.body;

    const { data: existing } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ ok: false });
    }

    const hash = await bcrypt.hash(senha, 10);

    await supabase.from('usuarios').insert([{
      email,
      senha_hash: hash,
      device_id,
      data_inicio_teste: new Date().toISOString(),
      assinatura_ativa: false
    }]);

    return res.json({ ok: true });

  } catch (err) {
    return res.status(500).json({ ok: false, msg: err.message });
  }
});

// 🔁 LOGIN
app.post('/login', async (req, res) => {
  try {
    const { email, senha, device_id } = req.body;

    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (!user) return res.status(401).json({ ok: false });

    const valid = await bcrypt.compare(senha, user.senha_hash);
    if (!valid) return res.status(401).json({ ok: false });

    await supabase.from('usuarios').update({ device_id }).eq('id', user.id);

    const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '7d' });

    return res.json({ ok: true, token });

  } catch (err) {
    return res.status(500).json({ ok: false });
  }
});

// 🔎 ASSINATURA
app.post('/assinatura', autenticar, async (req, res) => {
  try {
    const { device_id } = req.body;

    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', req.user_id)
      .maybeSingle();

    if (!user) return res.json({ ativo: false });

    const dias = Math.floor((Date.now() - new Date(user.data_inicio_teste)) / 86400000);
    const ativo = dias < 7 || user.assinatura_ativa;

    return res.json({ ativo });

  } catch {
    return res.json({ ativo: false });
  }
});

// 💰 CRIAR PIX
app.get('/criar-pagamento', autenticar, async (req, res) => {
  try {
    const externalReference = `assinatura_${req.user_id}_${Date.now()}`;

    const mp = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      {
        transaction_amount: 10,
        description: 'Assinatura',
        payment_method_id: 'pix',
        external_reference: externalReference,
        notification_url: `${BASE_URL}/webhook/mercadopago`,
        payer: { email: 'cliente@app.com' }
      },
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          'X-Idempotency-Key': crypto.randomUUID()
        }
      }
    );

    const data = mp.data.point_of_interaction.transaction_data;

    return res.json({
      qr: data.qr_code,
      qr_base64: data.qr_code_base64
    });

  } catch (err) {
    return res.status(500).json({ erro: 'erro pix' });
  }
});

// 🔔 WEBHOOK
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const id = req.query['data.id'];
    if (!id) return res.sendStatus(200);

    const mp = await axios.get(
      `https://api.mercadopago.com/v1/payments/${id}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const payment = mp.data;

    if (payment.status === 'approved') {
      const userId = payment.external_reference.split('_')[1];

      await supabase
        .from('usuarios')
        .update({ assinatura_ativa: true })
        .eq('id', userId);
    }

    res.sendStatus(200);
  } catch {
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000);
