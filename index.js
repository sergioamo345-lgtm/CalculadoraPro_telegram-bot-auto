require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

// ---------------- Middleware de autenticação ----------------
function autenticar(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ ok: false, msg: "Token não fornecido" });

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user_id = payload.user_id;
        next();
    } catch (err) {
        return res.status(401).json({ ok: false, msg: "Token inválido ou expirado" });
    }
}

// ---------------- Registro de usuário ----------------
app.post("/register", async (req, res) => {
    try {
        const { email, senha, device_id } = req.body;
        if (!email || !senha || !device_id) return res.status(400).json({ ok: false, msg: "Campos obrigatórios faltando" });

        // Verifica se usuário já existe
        const { data: existingUser } = await supabase
            .from("usuarios")
            .select("id")
            .eq("email", email)
            .single();

        if (existingUser) return res.status(409).json({ ok: false, msg: "Usuário já existe" });

        const senhaHash = await bcrypt.hash(senha, 10);

        const { data, error } = await supabase
            .from("usuarios")
            .insert([{
                email,
                senha_hash: senhaHash,
                device_id,
                data_inicio_teste: new Date().toISOString(),
                assinatura_ativa: false
            }])
            .select()
            .single();

        if (error) return res.status(500).json({ ok: false, error: error.message });

        return res.status(201).json({ ok: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ---------------- Login ----------------
app.post("/login", async (req, res) => {
    try {
        const { email, senha, device_id } = req.body;
        if (!email || !senha || !device_id) return res.status(400).json({ ok: false, msg: "Campos obrigatórios faltando" });

        const { data: user } = await supabase
            .from("usuarios")
            .select("*")
            .eq("email", email)
            .single();

        if (!user) return res.status(401).json({ ok: false, msg: "Usuário ou senha inválidos" });

        const senhaValida = await bcrypt.compare(senha, user.senha_hash);
        if (!senhaValida) return res.status(401).json({ ok: false, msg: "Usuário ou senha inválidos" });

        // Atualiza device_id apenas se for o mesmo user_id
        await supabase.from("usuarios")
            .update({ device_id })
            .eq("id", user.id);

        // Gera token JWT
        const token = jwt.sign({ user_id: user.id }, JWT_SECRET, { expiresIn: '7d' });

        // Registrar log de login
        await supabase.from("logs_uso").insert([{
            user_id: user.id,
            device_id,
            acao: 'login',
            data_hora: new Date().toISOString()
        }]);

        return res.json({ ok: true, token });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ---------------- Verificação de assinatura / teste ----------------
app.post("/assinatura", autenticar, async (req, res) => {
    try {
        const { device_id } = req.body;
        if (!device_id) return res.status(400).json({ ativo: false, msg: "device_id obrigatório" });

        const { data: user } = await supabase
            .from("usuarios")
            .select("*")
            .eq("id", req.user_id)
            .single();

        if (!user) return res.status(404).json({ ativo: false });

        // Verifica se o device_id bate com o cadastrado
        if (user.device_id !== device_id) return res.status(403).json({ ativo: false, msg: "Dispositivo não autorizado" });

        const hoje = new Date();
        const inicioTeste = new Date(user.data_inicio_teste);
        const diasDecorridos = Math.floor((hoje - inicioTeste) / (1000 * 60 * 60 * 24));

        const ativo = diasDecorridos < 7 || user.assinatura_ativa;

        // Registrar log de verificação
        await supabase.from("logs_uso").insert([{
            user_id: user.id,
            device_id,
            acao: 'verificacao_assinatura',
            data_hora: hoje.toISOString()
        }]);

        return res.json({ ativo });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ativo: false, error: err.message });
    }
});

// ---------------- Servidor ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
