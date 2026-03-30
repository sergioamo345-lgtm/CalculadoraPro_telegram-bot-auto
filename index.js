require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

if (
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_KEY ||
  !process.env.JWT_SECRET ||
  !process.env.MP_ACCESS_TOKEN
) {
  console.error('ERRO: faltam variáveis de ambiente');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.JWT_SECRET;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://calculadorapro-telegram-bot-auto.onrender.com';

app.get('/', (req, res) => {
  res.send('API ONLINE 🚀');
});

function autenticar(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ ok: false });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user_id = payload.user_id;
    next();
  } catch {
    return res.status(401).json({ ok: false });
  }
}

function autenticarQuery(req, res, next) {
  const token = req.query.token;
  if (!token) return res.status(401).send('Token inválido');

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user_id = payload.user_id;
    next();
  } catch {
    return res.status(401).send('Token inválido');
  }
}

async function buscarUsuarioPorId(id) {
  const { data } = await supabase.from('usuarios').select('*').eq('id', id).maybeSingle();
  return data;
}

//
// 🚀 ROTA NOVA (ESSENCIAL)
//
app.post('/auth-device', async (req, res) => {
  try {
    const { device_id } = req.body;

    if (!device_id) {
      return res.status(400).json({ ok: false, msg: 'device_id obrigatório' });
    }

    const email = `device_${device_id}@app.com`;
    const senha = device_id;

    let { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      const senhaHash = await bcrypt.hash(senha, 10);

      const { data: newUser, error } = await supabase
        .from('usuarios')
        .insert([{
          email,
          senha_hash: senhaHash,
          device_id,
          data_inicio_teste: new Date().toISOString(),
          assinatura_ativa: false
        }])
        .select()
        .single();

      if (error) {
        return res.status(500).json({ ok: false, msg: error.message });
      }

      user = newUser;
    }

    const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '7d' });

    return res.json({ ok: true, token });

  } catch (err) {
    console.error('ERRO /auth-device:', err);
    return res.status(500).json({ ok: false, msg: err.message });
  }
});

//
// LOGIN
//
app.post('/login', async (req, res) => {
  const { email, senha, device_id } = req.body;

  const { data: user } = await supabase
    .from('usuarios')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  if (!user) return res.status(401).json({ ok: false });

  const ok = await bcrypt.compare(senha, user.senha_hash);
  if (!ok) return res.status(401).json({ ok: false });

  await supabase.from('usuarios').update({ device_id }).eq('id', user.id);

  const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '7d' });

  return res.json({ ok: true, token });
});

//
// ASSINATURA
//
app.post('/assinatura', autenticar, async (req, res) => {
  const { device_id } = req.body;

  const user = await buscarUsuarioPorId(req.user_id);
  if (!user) return res.json({ ativo: false });

  if (user.device_id !== device_id) {
    return res.json({ ativo: false });
  }

  const dias = Math.floor((Date.now() - new Date(user.data_inicio_teste)) / (1000 * 60 * 60 * 24));

  const ativo = dias < 7 || user.assinatura_ativa;

  return res.json({ ativo });
});

//
// CHECKOUT
//
app.get('/checkout', autenticarQuery, async (req, res) => {
  const { device_id, token } = req.query;

  res.send(`
    <h1>Assinar</h1>
    <a href="/criar-pagamento?device_id=${device_id}&token=${token}">
      Pagar com PIX
    </a>
  `);
});

//
// PIX
//
app.get('/criar-pagamento', autenticarQuery, async (req, res) => {
  const user = await buscarUsuarioPorId(req.user_id);

  const payment = await axios.post(
    'https://api.mercadopago.com/v1/payments',
    {
      transaction_amount: 10,
      payment_method_id: 'pix',
      payer: { email: user.email },
      external_reference: `assinatura_${user.id}`,
      notification_url: `${BASE_URL}/webhook/mercadopago`
    },
    {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    }
  );

  const qr = payment.data.point_of_interaction.transaction_data.qr_code;

  res.send(`<textarea>${qr}</textarea>`);
});

//
// WEBHOOK
//
app.post('/webhook/mercadopago', async (req, res) => {
  const id = req.body?.data?.id;
  if (!id) return res.sendStatus(200);

  const payment = await axios.get(
    `https://api.mercadopago.com/v1/payments/${id}`,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );

  const ref = payment.data.external_reference;

  if (payment.data.status === 'approved') {
    const userId = ref.split('_')[1];

    await supabase
      .from('usuarios')
      .update({ assinatura_ativa: true })
      .eq('id', userId);
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Servidor rodando 🚀');
});
