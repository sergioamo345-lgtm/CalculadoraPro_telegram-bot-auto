require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY || !process.env.JWT_SECRET) {
  console.error('Variáveis de ambiente faltando: SUPABASE_URL, SUPABASE_KEY ou JWT_SECRET');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

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
  } catch {
    return res.status(401).json({ ok: false, msg: 'Token inválido ou expirado' });
  }
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

    const { error } = await supabase
      .from('usuarios')
      .insert([{
        email,
        senha_hash: senhaHash,
        device_id,
        data_inicio_teste: new Date().toISOString(),
        assinatura_ativa: false
      }]);

    if (error) {
      return res.status(500).json({ ok: false, msg: error.message });
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

    const { data: user, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ ok: false, msg: error.message });
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

    const { data: user, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', req.user_id)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ ativo: false, msg: error.message });
    }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
