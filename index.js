const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// VARIÁVEIS
const token = process.env.TELEGRAM_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!token || !supabaseUrl || !supabaseKey) {
  throw new Error("❌ Variáveis não configuradas");
}

// INICIAR
const bot = new TelegramBot(token, { polling: true });
const supabase = createClient(supabaseUrl, supabaseKey);

// CRIAR USUÁRIO (7 dias grátis)
async function criarUsuario(id) {
  const dataExpiracao = new Date();
  dataExpiracao.setDate(dataExpiracao.getDate() + 7);

  await supabase.from('usuarios').insert([
    {
      id: id,
      status: 'trial',
      data_expiracao: dataExpiracao
    }
  ]);
}

// VERIFICAR ACESSO
async function verificarAcesso(id) {
  const { data } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', id)
    .single();

  if (!data) return false;

  const agora = new Date();
  const expiracao = new Date(data.data_expiracao);

  return agora <= expiracao;
}

// COMANDO /start (NOVO SISTEMA)
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  const { data } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', chatId)
    .single();

  if (!data) {
    await criarUsuario(chatId);
    return bot.sendMessage(chatId, "🎁 Você ganhou 7 dias grátis!");
  }

  const acesso = await verificarAcesso(chatId);

  if (!acesso) {
    return bot.sendMessage(chatId, "🔒 Seu acesso expirou. Use /comprar");
  }

  bot.sendMessage(chatId, "✅ Acesso liberado!");
});

// ERROS
bot.on("polling_error", (error) => {
  console.log(error);
});
