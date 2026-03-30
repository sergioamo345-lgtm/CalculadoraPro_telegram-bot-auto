require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ===== CONFIG =====
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

// ===== TESTE =====
app.get('/', (req, res) => {
  res.send('API ONLINE 🚀');
});

// ===== REGISTER =====
app.post('/register', async (req, res) => {
  try {
    const { email, senha, device_id } = req.body;

    if (!email || !senha || !device_id) {
      return res.status(400).json({ ok: false, msg: 'Dados inválidos' });
    }

    const { data: existing } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ ok: false, msg: 'Já existe' });
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
    console.error(err);
    return res.status(500).json({ ok: false, msg: err.message });
  }
});

// ===== LOGIN (CORRIGIDO) =====
app.post('/login', async (req, res) => {
  try {
    const { email, senha, device_id } = req.body;

    if (!email || !senha || !device_id) {
      return res.status(400).json({ ok: false, msg: 'Dados inválidos' });
    }

    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(401).json({ ok: false, msg: 'Usuário não encontrado' });
    }

    const valid = await bcrypt.compare(senha, user.senha_hash);

    if (!valid) {
      return res.status(401).json({ ok: false, msg: 'Senha inválida' });
    }

    // Atualiza device_id
    await supabase
      .from('usuarios')
      .update({ device_id })
      .eq('id', user.id);

    // 🔥 IMPORTANTE: SEMPRE gerar token
    const token = jwt.sign(
      { user_id: user.id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      ok: true,
      token: token // 🔥 ESSENCIAL PRO APP
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, msg: err.message });
  }
});

// ===== ASSINATURA =====
app.post('/assinatura', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ ativo: false, msg: 'Sem token' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    const userId = decoded.user_id;

    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({ ativo: false });
    }

    const hoje = new Date();
    const inicioTeste = new Date(user.data_inicio_teste);
    const dias = Math.floor((hoje - inicioTeste) / (1000 * 60 * 60 * 24));

    const ativo = dias < 7 || user.assinatura_ativa;

    return res.json({
      ativo: ativo,
      em_teste: dias < 7,
      dias_restantes_teste: Math.max(0, 7 - dias),
      assinatura_ativa: user.assinatura_ativa
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ativo: false });
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor rodando 🚀');
});
