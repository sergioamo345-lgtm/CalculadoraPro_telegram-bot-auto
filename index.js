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
  console.error('ERRO: faltam SUPABASE_URL, SUPABASE_KEY, JWT_SECRET ou MP_ACCESS_TOKEN');
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
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ ok: false, msg: 'Token não fornecido' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user_id = payload.user_id;
    next();
  } catch (err) {
    console.error('ERRO JWT:', err.message);
    return res.status(401).json({ ok: false, msg: 'Token inválido ou expirado' });
  }
}

function autenticarQuery(req, res, next) {
  const token = req.query.token;

  if (!token) {
    return res.status(401).send('Token não fornecido');
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user_id = payload.user_id;
    next();
  } catch (err) {
    console.error('ERRO JWT QUERY:', err.message);
    return res.status(401).send('Token inválido ou expirado');
  }
}

async function buscarUsuarioPorId(userId) {
  const { data: user, error } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return user;
}

app.post('/register', async (req, res) => {
  try {
    const { email, senha, device_id } = req.body || {};

    if (!email || !senha || !device_id) {
      return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando' });
    }

    const { data: existingUser, error: existingError } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({ ok: false, msg: existingError.message });
    }

    if (existingUser) {
      return res.status(409).json({ ok: false, msg: 'Usuário já existe' });
    }

    const senhaHash = await bcrypt.hash(senha, 10);

    const { error: insertError } = await supabase
      .from('usuarios')
      .insert([{
        email,
        senha_hash: senhaHash,
        device_id,
        data_inicio_teste: new Date().toISOString(),
        assinatura_ativa: false
      }]);

    if (insertError) {
      return res.status(500).json({ ok: false, msg: insertError.message });
    }

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('ERRO /register:', err);
    return res.status(500).json({ ok: false, msg: err.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, senha, device_id } = req.body || {};

    if (!email || !senha || !device_id) {
      return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando' });
    }

    const { data: user, error: userError } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (userError) {
      return res.status(500).json({ ok: false, msg: userError.message });
    }

    if (!user) {
      return res.status(401).json({ ok: false, msg: 'Usuário ou senha inválidos' });
    }

    const senhaValida = await bcrypt.compare(senha, user.senha_hash);
    if (!senhaValida) {
      return res.status(401).json({ ok: false, msg: 'Usuário ou senha inválidos' });
    }

    const { error: updateError } = await supabase
      .from('usuarios')
      .update({ device_id })
      .eq('id', user.id);

    if (updateError) {
      return res.status(500).json({ ok: false, msg: updateError.message });
    }

    const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '7d' });

    await supabase.from('logs_uso').insert([{
      user_id: user.id,
      device_id,
      acao: 'login',
      data_hora: new Date().toISOString()
    }]);

    return res.json({ ok: true, token });
  } catch (err) {
    console.error('ERRO /login:', err);
    return res.status(500).json({ ok: false, msg: err.message });
  }
});

app.post('/assinatura', autenticar, async (req, res) => {
  try {
    const { device_id } = req.body || {};

    if (!device_id) {
      return res.status(400).json({ ativo: false, msg: 'device_id obrigatório' });
    }

    const user = await buscarUsuarioPorId(req.user_id);

    if (!user) {
      return res.status(404).json({ ativo: false, msg: 'Usuário não encontrado' });
    }

    if (user.device_id !== device_id) {
      return res.status(403).json({ ativo: false, msg: 'Dispositivo não autorizado' });
    }

    const hoje = new Date();
    const inicioTeste = new Date(user.data_inicio_teste);
    const diasDecorridos = Math.floor((hoje - inicioTeste) / (1000 * 60 * 60 * 24));
    const ativo = diasDecorridos < 7 || user.assinatura_ativa;

    await supabase.from('logs_uso').insert([{
      user_id: user.id,
      device_id,
      acao: 'verificacao_assinatura',
      data_hora: hoje.toISOString()
    }]);

    return res.json({ ativo });
  } catch (err) {
    console.error('ERRO /assinatura:', err);
    return res.status(500).json({ ativo: false, msg: err.message });
  }
});

app.get('/checkout', autenticarQuery, async (req, res) => {
  try {
    const { device_id, token } = req.query;

    if (!device_id) {
      return res.status(400).send('device_id obrigatório');
    }

    const user = await buscarUsuarioPorId(req.user_id);

    if (!user) {
      return res.status(404).send('Usuário não encontrado');
    }

    if (user.device_id !== device_id) {
      return res.status(403).send('Dispositivo não autorizado');
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Assinatura</title>
        <style>
          body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; background:#0f172a; color:#fff; font-family:Arial,sans-serif; }
          .card { width:100%; max-width:460px; background:#111827; border-radius:24px; padding:28px; box-shadow:0 20px 60px rgba(0,0,0,.35); }
          h1 { margin:0 0 12px; font-size:30px; }
          p, li { color:#cbd5e1; line-height:1.5; }
          .price { font-size:32px; color:#4ade80; font-weight:bold; margin:18px 0 8px; }
          .btn { display:block; width:100%; text-align:center; text-decoration:none; border-radius:16px; padding:16px; font-weight:bold; margin-top:16px; }
          .primary { background:#16a34a; color:#fff; }
          .secondary { background:#1f2937; color:#e5e7eb; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Seu teste grátis acabou</h1>
          <p>Continue usando o app e evite corridas ruins automaticamente.</p>
          <ul>
            <li>Evite corridas que dão prejuízo</li>
            <li>Veja o valor real antes de aceitar</li>
            <li>Aumente seu lucro por km</li>
            <li>Funciona automaticamente enquanto dirige</li>
          </ul>
          <div class="price">R$10/mês</div>
          <a class="btn primary" href="/criar-pagamento?device_id=${encodeURIComponent(device_id)}&token=${encodeURIComponent(token)}">Assinar agora com PIX</a>
          <a class="btn secondary" href="/">Voltar</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('ERRO /checkout:', err);
    return res.status(500).send('Erro interno no checkout');
  }
});

app.get('/criar-pagamento', autenticarQuery, async (req, res) => {
  try {
    const { device_id, token } = req.query;

    if (!device_id) {
      return res.status(400).send('device_id obrigatório');
    }

    const user = await buscarUsuarioPorId(req.user_id);

    if (!user) {
      return res.status(404).send('Usuário não encontrado');
    }

    if (user.device_id !== device_id) {
      return res.status(403).send('Dispositivo não autorizado');
    }

    const idempotencyKey = crypto.randomUUID();
    const externalReference = `assinatura_${user.id}_${Date.now()}`;

    const mpResponse = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      {
        transaction_amount: 10,
        description: 'Assinatura mensal CauculatorStudy2',
        payment_method_id: 'pix',
        external_reference: externalReference,
        notification_url: `${BASE_URL}/webhook/mercadopago`,
        payer: {
          email: user.email
        }
      },
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey
        },
        timeout: 30000
      }
    );

    const payment = mpResponse.data;
    const qrCode = payment?.point_of_interaction?.transaction_data?.qr_code;
    const qrCodeBase64 = payment?.point_of_interaction?.transaction_data?.qr_code_base64;
    const ticketUrl = payment?.point_of_interaction?.transaction_data?.ticket_url;
    const paymentId = payment?.id;

    await supabase.from('logs_uso').insert([{
      user_id: user.id,
      device_id,
      acao: 'pix_criado',
      data_hora: new Date().toISOString()
    }]);

    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Pagamento PIX</title>
        <style>
          body { margin:0; min-height:100vh; background:#0f172a; color:#fff; font-family:Arial,sans-serif; display:flex; align-items:center; justify-content:center; padding:24px; }
          .card { width:100%; max-width:560px; background:#111827; border-radius:24px; padding:28px; box-shadow:0 20px 60px rgba(0,0,0,.35); }
          .price { color:#4ade80; font-size:28px; font-weight:bold; margin:8px 0 20px; }
          .qr { background:#fff; border-radius:18px; padding:16px; display:flex; justify-content:center; margin:20px 0; }
          textarea { width:100%; min-height:120px; border-radius:12px; border:none; padding:12px; font-size:14px; }
          a { color:#86efac; }
          .btn { display:inline-block; margin-top:16px; padding:14px 18px; border-radius:12px; background:#16a34a; color:#fff; text-decoration:none; font-weight:bold; }
          .muted { color:#94a3b8; font-size:13px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Pagamento via PIX</h1>
          <div class="price">R$10,00</div>
          <p>Escaneie o QR Code ou copie o código PIX abaixo.</p>

          ${qrCodeBase64 ? `<div class="qr"><img alt="QR Code PIX" style="max-width:260px;width:100%;" src="data:image/png;base64,${qrCodeBase64}" /></div>` : ''}

          ${qrCode ? `<textarea readonly>${qrCode}</textarea>` : '<p>Não foi possível gerar o código PIX.</p>'}

          ${ticketUrl ? `<p><a href="${ticketUrl}" target="_blank" rel="noopener noreferrer">Abrir página do pagamento</a></p>` : ''}

          <p class="muted">Pagamento ID: ${paymentId || '-'}</p>
          <a class="btn" href="/checkout?device_id=${encodeURIComponent(device_id)}&token=${encodeURIComponent(token)}">Voltar</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('ERRO /criar-pagamento:', err.response?.data || err.message);
    return res.status(500).send('Erro ao gerar pagamento PIX');
  }
});

app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const topic = req.query.type || req.body?.type;
    const paymentId = req.query['data.id'] || req.body?.data?.id;

    if (topic !== 'payment' || !paymentId) {
      return res.sendStatus(200);
    }

    const paymentResponse = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`
        },
        timeout: 30000
      }
    );

    const payment = paymentResponse.data;
    const externalReference = payment.external_reference || '';
    const status = payment.status;

    if (status === 'approved' && externalReference.startsWith('assinatura_')) {
      const userId = externalReference.split('_')[1];

      await supabase
        .from('usuarios')
        .update({ assinatura_ativa: true })
        .eq('id', userId);

      await supabase.from('logs_uso').insert([{
        user_id: userId,
        device_id: null,
        acao: 'assinatura_aprovada_mp',
        data_hora: new Date().toISOString()
      }]);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('ERRO /webhook/mercadopago:', err.response?.data || err.message);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
