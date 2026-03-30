require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(bodyParser.json());

// ===== CONFIG =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const mpClient = new MercadoPagoConfig({ accessToken: MP_TOKEN });

// =============================
// 🔐 LOGIN AUTOMÁTICO POR DEVICE
// =============================
app.post('/auth-device', async (req, res) => {
  try {
    const { device_id } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: 'device_id obrigatório' });
    }

    let { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('device_id', device_id)
      .maybeSingle();

    // 🔥 se não existir → cria automaticamente
    if (!user) {
      const { data: newUser } = await supabase
        .from('usuarios')
        .insert([{
          device_id,
          assinatura_ativa: false,
          criado_em: new Date().toISOString()
        }])
        .select()
        .single();

      user = newUser;
    }

    const token = jwt.sign(
      { user_id: user.id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({ token });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// =============================
// 💳 GERAR PIX
// =============================
app.post('/criar-pagamento', async (req, res) => {
  try {
    const { device_id } = req.body;

    const payment = await new Payment(mpClient).create({
      body: {
        transaction_amount: 10,
        description: "Assinatura Calculadora Moto PRO",
        payment_method_id: "pix",
        payer: {
          email: "comprador@email.com"
        }
      }
    });

    await supabase.from('pagamentos').insert([{
      device_id,
      payment_id: payment.id,
      status: 'pending'
    }]);

    res.json({
      qr_code: payment.point_of_interaction.transaction_data.qr_code,
      qr_code_base64: payment.point_of_interaction.transaction_data.qr_code_base64
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao gerar pagamento' });
  }
});

// =============================
// 🔔 WEBHOOK MERCADO PAGO
// =============================
app.post('/webhook', async (req, res) => {
  try {
    const paymentId = req.body.data.id;

    const payment = await new Payment(mpClient).get({ id: paymentId });

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
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// =============================
// 📡 STATUS DA ASSINATURA
// =============================
app.post('/assinatura', async (req, res) => {
  try {
    const { device_id } = req.body;

    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('device_id', device_id)
      .maybeSingle();

    if (!user) {
      return res.json({ ativo: false });
    }

    return res.json({
      ativo: user.assinatura_ativa === true
    });

  } catch (err) {
    res.status(500).json({ ativo: false });
  }
});

// =============================
app.get('/', (req, res) => {
  res.send('API rodando 🚀');
});

// =============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Servidor rodando 🚀'));
