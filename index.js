// ... (todo o código anterior igual ao que já montamos)

    if (data === "ADMIN_LIST_LOGS") {
        const { data: logs } = await supabase
            .from('logs_suspeitos')
            .select('*')
            .limit(20)
            .order('data', { ascending: false });
        if (!logs || logs.length === 0) return bot.sendMessage(chatId, "❌ Nenhum log suspeito.");
        let text = "⚠️ Últimos logs:\n";
        logs.forEach(l => text += `${new Date(l.data).toLocaleString()} - ${l.tipo} - ${l.descricao}\n`);
        bot.sendMessage(chatId, text);
    }

    if (data.startsWith("BLOCK_")) {
        const userId = data.split("_")[1];
        await supabase.from('usuarios').update({ status: "bloqueado" }).eq('chat_id', userId);
        bot.sendMessage(chatId, `🚫 Usuário ${userId} bloqueado.`);
    }

    if (data.startsWith("UNBLOCK_")) {
        const userId = data.split("_")[1];
        await supabase.from('usuarios').update({ status: "ativo" }).eq('chat_id', userId);
        bot.sendMessage(chatId, `✅ Usuário ${userId} liberado.`);
    }

    if (data.startsWith("RESET_")) {
        const userId = data.split("_")[1];
        const novaData = new Date();
        novaData.setDate(novaData.getDate() + 7);
        await supabase.from('usuarios').update({ expires_at: novaData, ja_usou_trial: true }).eq('chat_id', userId);
        bot.sendMessage(chatId, `🔄 Trial do usuário ${userId} resetado por 7 dias.`);
    }
}); // <-- fecha o callback_query

// ===== Webhook Mercado Pago =====
app.post('/webhook', async (req, res) => {
    const { id, type } = req.body;
    if (type !== 'payment') return res.sendStatus(200);
    try {
        const result = await mpPayment.get({ id });
        const chatId = result.metadata?.chat_id;
        if (chatId) {
            const novaData = new Date();
            novaData.setMonth(novaData.getMonth() + 1);
            await supabase.from('usuarios').update({ status: "ativo", expires_at: novaData, tentativas_pix: 0 }).eq('chat_id', chatId);
            bot.sendMessage(chatId, "✅ Pagamento confirmado! Acesso liberado por 1 mês.");
        }
        res.sendStatus(200);
    } catch (err) {
        console.log("❌ WEBHOOK ERROR:", err);
        res.sendStatus(500);
    }
});

// ===== Start Express =====
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
