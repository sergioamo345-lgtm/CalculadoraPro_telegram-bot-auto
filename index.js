require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY || !process.env.JWT_SECRET) {
  console.error('ERRO: faltam SUPABASE_URL, SUPABASE_KEY ou JWT_SECRET');
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

app.post('/register', async (req, res) => {
  try {
    console.log('BODY /register:', req.body);

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
      console.error('SUPABASE /register select:', existingError);
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
      console.error('SUPABASE /register insert:', insertError);
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
    console.log('BODY /login:', req.body);

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
      console.error('SUPABASE /login select:', userError);
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
      console.error('SUPABASE /login update device:', updateError);
      return res.status(500).json({ ok: false, msg: updateError.message });
    }

    const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '7d' });

    const { error: logError } = await supabase
      .from('logs_uso')
      .insert([{
        user_id: user.id,
        device_id,
        acao: 'login',
        data_hora: new Date().toISOString()
      }]);

    if (logError) {
      console.error('SUPABASE /login log:', logError);
    }

    return res.json({ ok: true, token });
  } catch (err) {
    console.error('ERRO /login:', err);
    return res.status(500).json({ ok: false, msg: err.message });
  }
});

app.post('/assinatura', autenticar, async (req, res) => {
  try {
    console.log('BODY /assinatura:', req.body, 'USER_ID:', req.user_id);

    const { device_id } = req.body || {};

    if (!device_id) {
      return res.status(400).json({ ativo: false, msg: 'device_id obrigatório' });
    }

    const { data: user, error: userError } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', req.user_id)
      .maybeSingle();

    if (userError) {
      console.error('SUPABASE /assinatura select:', userError);
      return res.status(500).json({ ativo: false, msg: userError.message });
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

    const { error: logError } = await supabase
      .from('logs_uso')
      .insert([{
        user_id: user.id,
        device_id,
        acao: 'verificacao_assinatura',
        data_hora: hoje.toISOString()
      }]);

    if (logError) {
      console.error('SUPABASE /assinatura log:', logError);
    }

    return res.json({ ativo });
  } catch (err) {
    console.error('ERRO /assinatura:', err);
    return res.status(500).json({ ativo: false, msg: err.message });
  }
});

app.get('/checkout', autenticarQuery, async (req, res) => {
  try {
    const { device_id } = req.query;

    if (!device_id) {
      return res.status(400).send('device_id obrigatório');
    }

    const { data: user, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', req.user_id)
      .maybeSingle();

    if (error) {
      console.error('SUPABASE /checkout select:', error);
      return res.status(500).send('Erro ao validar usuário');
    }

    if (!user) {
      return res.status(404).send('Usuário não encontrado');
    }

    if (user.device_id !== device_id) {
      return res.status(403).send('Dispositivo não autorizado');
    }

    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Assinatura</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            min-height: 100vh;
            font-family: Arial, sans-serif;
            background: linear-gradient(180deg, #0b1220 0%, #111827 100%);
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
          }
          .card {
            width: 100%;
            max-width: 460px;
            background: rgba(17, 24, 39, 0.96);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 24px;
            padding: 28px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.35);
          }
          .badge {
            display: inline-block;
            background: rgba(34,197,94,0.16);
            color: #86efac;
            padding: 8px 12px;
            border-radius: 999px;
            font-size: 13px;
            margin-bottom: 16px;
          }
          h1 {
            margin: 0 0 12px;
            font-size: 30px;
            line-height: 1.15;
          }
          p {
            margin: 0 0 18px;
            color: #cbd5e1;
            line-height: 1.5;
          }
          ul {
            padding-left: 20px;
            margin: 0 0 24px;
            color: #e5e7eb;
          }
          li { margin-bottom: 10px; }
          .price {
            font-size: 32px;
            font-weight: bold;
            color: #4ade80;
            margin-bottom: 8px;
          }
          .hint {
            color: #94a3b8;
            font-size: 14px;
            margin-bottom: 24px;
          }
          .btn {
            display: block;
            width: 100%;
            text-align: center;
            text-decoration: none;
            border: none;
            cursor: pointer;
            border-radius: 16px;
            padding: 16px 18px;
            font-size: 17px;
            font-weight: bold;
            transition: transform .15s ease, opacity .15s ease;
          }
          .btn:hover {
            transform: translateY(-1px);
          }
          .btn-primary {
            background: #16a34a;
            color: white;
          }
          .btn-secondary {
            background: rgba(255,255,255,0.06);
            color: #e5e7eb;
            margin-top: 12px;
          }
          .meta {
            margin-top: 18px;
            font-size: 12px;
            color: #64748b;
            word-break: break-all;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">Assinatura do app</div>
          <h1>Seu acesso premium está bloqueado</h1>
          <p>Continue usando o app e evite corridas ruins automaticamente.</p>

          <ul>
            <li>Evite corridas que dão prejuízo</li>
            <li>Veja o valor real antes de aceitar</li>
            <li>Aumente seu lucro por km</li>
            <li>Funciona automaticamente enquanto dirige</li>
          </ul>

          <div class="price">R$10/mês</div>
          <div class="hint">Menos que 1 corrida ruim por mês</div>

          <a class="btn btn-primary" href="/criar-pagamento?device_id=${encodeURIComponent(device_id)}&token=${encodeURIComponent(req.query.token)}">
            Assinar agora
          </a>

          <a class="btn btn-secondary" href="/">
            Voltar
          </a>

          <div class="meta">device_id: ${device_id}</div>
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
    const { device_id } = req.query;

    if (!device_id) {
      return res.status(400).send('device_id obrigatório');
    }

    const { data: user, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', req.user_id)
      .maybeSingle();

    if (error) {
      console.error('SUPABASE /criar-pagamento select:', error);
      return res.status(500).send('Erro ao validar usuário');
    }

    if (!user) {
      return res.status(404).send('Usuário não encontrado');
    }

    if (user.device_id !== device_id) {
      return res.status(403).send('Dispositivo não autorizado');
    }

    // Placeholder até integrar Mercado Pago/PIX real.
    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Pagamento</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            font-family: Arial, sans-serif;
            background: #0f172a;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
          }
          .card {
            width: 100%;
            max-width: 520px;
            background: #111827;
            border-radius: 24px;
            padding: 28px;
            box-shadow: 0 20px 60px rgba(0,0,0,.35);
          }
          h1 { margin-top: 0; }
          p { color: #cbd5e1; line-height: 1.5; }
          .box {
            background: rgba(255,255,255,0.06);
            border-radius: 16px;
            padding: 16px;
            margin-top: 18px;
          }
          .ok {
            color: #4ade80;
            font-weight: bold;
          }
          a {
            display: inline-block;
            margin-top: 18px;
            color: #86efac;
            text-decoration: none;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Pagamento em preparação</h1>
          <p class="ok">A rota está pronta e validando o usuário corretamente.</p>
          <p>Agora falta apenas integrar aqui o link real do Mercado Pago ou gerar o PIX automaticamente.</p>

          <div class="box">
            <div>Usuário: ${user.email}</div>
            <div>device_id: ${device_id}</div>
          </div>

          <a href="/checkout?device_id=${encodeURIComponent(device_id)}&token=${encodeURIComponent(req.query.token)}">
            Voltar para assinatura
          </a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('ERRO /criar-pagamento:', err);
    return res.status(500).send('Erro interno ao criar pagamento');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
