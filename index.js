require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ===== CONFIG =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const MP_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERRO: SUPABASE_URL ou SUPABASE_KEY não configurados no ambiente.');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('ERRO: JWT_SECRET não configurado no ambiente.');
  process.exit(1);
}
if (!MP_TOKEN) {
  console.warn('AVISO: MP_ACCESS_TOKEN não configurado. Rotas de pagamento vão falhar.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function idempotencyKeyFor(deviceId) {
  const windowMs = 5 * 60 * 1000; // 5 min (evita duplicar se clicar várias vezes)
  const bucket = Math.floor(Date.now() / windowMs);
  return crypto
    .createHash('sha256')
    .update(`pix:${deviceId}:${bucket}`)
    .digest('hex')
    .slice(0, 32);
}

async function createPixPaymentForDevice(device_id) {
  if (!device_id) {
    const err = new Error('device_id obrigatório');
    err.statusCode = 400;
    throw err;
  }

  const externalReference = `assinatura_${device_id}_${Date.now()}`;

  const response = await axios.post(
    'https://api.mercadopago.com/v1/payments',
    {
      transaction_amount: 10,
      description: 'Assinatura Calculadora Moto PRO',
      payment_method_id: 'pix',
      external_reference: externalReference,
      payer: { email: 'cliente@email.com' }
    },
    {
      headers: {
        Authorization: `Bearer ${MP_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKeyFor(device_id)
      },
      timeout: 30000
    }
  );

  const payment = response.data;

  await supabase.from('pagamentos').insert([{
    device_id,
    payment_id: payment.id,
    status: 'pending'
  }]);

  const tx = payment?.point_of_interaction?.transaction_data || {};
  return {
    paymentId: payment.id,
    qr_code: tx.qr_code,
    qr_code_base64: tx.qr_code_base64
  };
}

// =============================
// 🔐 LOGIN / REGISTRO AUTOMÁTICO POR DEVICE
// =============================
async function authDeviceHandler(req, res) {
  try {
    const { device_id } = req.body;

    if (!device_id) {
      return res.status(400).json({ ok: false, error: 'device_id obrigatório' });
    }

    let { data: user, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('device_id', device_id)
      .maybeSingle();

    if (error) {
      console.error('Erro ao buscar usuário:', error);
    }

    if (!user) {
      const { data, error: insertError } = await supabase
        .from('usuarios')
        .insert([{
          device_id,
          assinatura_ativa: false,
          criado_em: new Date().toISOString()
        }])
        .select()
        .single();

      if (insertError || !data) {
        console.error('Erro ao criar usuário:', insertError);
        return res.status(500).json({ ok: false, error: 'Erro ao criar usuário' });
      }

      user = data;
    }

    if (!user || !user.id) {
      console.error('Usuário inválido:', user);
      return res.status(500).json({ ok: false, error: 'Usuário inválido' });
    }

    const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ ok: true, token });
  } catch (err) {
    console.error('ERRO AUTH:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno' });
  }
}

app.post('/auth-device', authDeviceHandler);
app.post('/register', authDeviceHandler);

// =============================
// ✅ CHECKOUT (WEBVIEW)
// =============================
app.get('/checkout', async (req, res) => {
  try {
    const device_id = String(req.query.device_id || '').trim();

    const pix = await createPixPaymentForDevice(device_id);

    const qrText = pix.qr_code || '';
    const qrImg = pix.qr_code_base64 ? `data:image/png;base64,${pix.qr_code_base64}` : '';

    res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(`
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1" />
  <title>Pagamento PIX</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; background:#0f1c2b; color:#e8f0fb; margin:0; padding:18px;}
    .card{background:#152a40; border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:16px; max-width:540px; margin:0 auto;}
    .title{font-size:18px; font-weight:700; margin:0 0 8px;}
    .muted{opacity:.85; font-size:13px; margin:0 0 14px;}
    .qr{display:flex; justify-content:center; margin:14px 0;}
    img{max-width:320px; width:100%; height:auto; border-radius:10px; background:#fff; padding:10px;}
    textarea{width:100%; min-height:110px; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:#0f1c2b; color:#e8f0fb; padding:12px; font-size:12px; resize:none;}
    button{width:100%; border:0; border-radius:12px; padding:14px 12px; font-size:16px; font-weight:700; background:#0F9D58; color:#fff; margin-top:10px;}
    .hint{margin-top:10px; font-size:12px; opacity:.85;}
    .pill{display:inline-block; padding:6px 10px; border-radius:999px; background:rgba(46, 204, 113, .14); border:1px solid rgba(46, 204, 113, .35); color:#a5f0b2; font-size:12px; margin-top:10px;}
  </style>
</head>
<body>
  <div class="card">
    <p class="title">Pagamento PIX (Mercado Pago)</p>
    <p class="muted">Escaneie o QR Code ou copie o código abaixo.</p>

    ${qrImg ? `<div class="qr"><img alt="QR Code PIX" src="${qrImg}"></div>` : `<p class="muted">QR Code indisponível, use o código copia-e-cola.</p>`}

    <textarea id="pix" readonly>${escapeHtml(qrText)}</textarea>
    <button id="copy">Copiar código PIX</button>

    <div class="pill">Depois que o Mercado Pago confirmar, o app libera automaticamente.</div>
    <div class="hint">ID do pagamento: ${escapeHtml(pix.paymentId)}</div>
  </div>

  <script>
    const btn = document.getElementById('copy');
    const txt = document.getElementById('pix');
    btn.addEventListener('click', async () => {
      try {
        txt.focus();
        txt.select();
        txt.setSelectionRange(0, 999999);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(txt.value);
        } else {
          document.execCommand('copy');
        }
        btn.textContent = 'Copiado!';
        setTimeout(() => btn.textContent = 'Copiar código PIX', 1200);
      } catch (e) {
        alert('Não foi possível copiar automaticamente. Selecione e copie manualmente.');
      }
    });
  </script>
</body>
</html>
    `.trim());
  } catch (err) {
    console.error('Erro /checkout:', err.response?.data || err.message || err);
    res.status(500).send('Erro ao carregar checkout.');
  }
});

// =============================
// 💳 GERAR PIX (API)
// =============================
app.post('/criar-pagamento', async (req, res) => {
  try {
    const { device_id } = req.body;
    const pix = await createPixPaymentForDevice(device_id);
    return res.json({ qr_code: pix.qr_code, qr_code_base64: pix.qr_code_base64 });
  } catch (err) {
    console.error('Erro pagamento:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Erro ao gerar pagamento' });
  }
});

// =============================
// 🔔 WEBHOOK MERCADO PAGO
// =============================
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const paymentId = req.query['data.id'] || req.body?.data?.id;

    if (!paymentId) {
      console.log('Webhook sem paymentId');
      return res.sendStatus(200);
    }

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MP_TOKEN}` }, timeout: 30000 }
    );

    const payment = response.data;

    if (payment.status === 'approved') {
      const { data: pagamento } = await supabase
        .from('pagamentos')
        .select('*')
        .eq('payment_id', paymentId)
        .maybeSingle();

      if (pagamento) {
        await supabase
          .from('usuarios')
          .update({ assinatura_ativa: true })
          .eq('device_id', pagamento.device_id);

        await supabase
          .from('pagamentos')
          .update({ status: 'approved' })
          .eq('payment_id', paymentId);

        console.log('Pagamento aprovado e liberado!');
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Erro webhook:', err.response?.data || err.message);
    return res.sendStatus(500);
  }
});

// =============================
// 📡 STATUS DA ASSINATURA
// =============================
app.post('/assinatura', async (req, res) => {
  try {
    const { device_id } = req.body;

    if (!device_id) return res.json({ ativo: false });

    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('device_id', device_id)
      .maybeSingle();

    return res.json({ ativo: user?.assinatura_ativa === true });
  } catch (err) {
    console.error('Erro assinatura:', err);
    return res.status(500).json({ ativo: false });
  }
});

app.get('/', (req, res) => res.send('API rodando 🚀'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Servidor rodando 🚀'));
