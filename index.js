require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

// ===== CONFIG =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// =============================
// 🔐 LOGIN AUTOMÁTICO POR DEVICE
// =============================
app.post('/auth-device', async (req, res) => {
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

    // 🔥 SE NÃO EXISTE → CRIA
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

    const token = jwt.sign(
      { user_id: user.id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({ ok: true, token });

  } catch (err) {
    console.error('ERRO AUTH:', err);
    res.status(500).json({ ok: false, error: 'Erro interno' });
  }
});

// =============================
// 💳 GERAR PIX
// =============================
app.post('/criar-pagamento', async (req, res) => {
  try {
    const { device_id } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: 'device_id obrigatório' });
    }

    const externalReference = `assinatura_${device_id}_${Date.now()}`;

    const response = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      {
        transaction_amount: 10,
        description: 'Assinatura Calculadora Moto PRO',
        payment_method_id: 'pix',
        external_reference: externalReference,
        payer: {
          email: 'cliente@email.com'
        }
      },
      {
        headers: {
          Authorization: `Bearer ${MP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const payment = response.data;

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
    console.error('Erro pagamento:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao gerar pagamento' });
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
      {
        headers: {
          Authorization: `Bearer ${MP_TOKEN}`
        }
      }
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

    res.sendStatus(200);

  } catch (err) {
    console.error('Erro webhook:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// =============================
// 📡 STATUS DA ASSINATURA
// =============================
app.post('/assinatura', async (req, res) => {
  try {
    const { device_id } = req.body;

    if (!device_id) {
      return res.json({ ativo: false });
    }

    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('device_id', device_id)
      .maybeSingle();

    return res.json({
      ativo: user?.assinatura_ativa === true
    });

  } catch (err) {
    console.error('Erro assinatura:', err);
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
