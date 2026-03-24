require("dotenv").config(); // v3
const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
const fs = require("fs");
const { extractFromImage } = require("./gemini");
const { saveTransaction, getTransactionsSince, getSummary } = require("./database");
const { generateExcel } = require("./excel");

const required = ["TELEGRAM_BOT_TOKEN","AUTHORIZED_USER_ID","ANTHROPIC_API_KEY","SUPABASE_URL","SUPABASE_ANON_KEY"];
required.forEach(k => { if (!process.env[k]) { console.error(`Falta: ${k}`); process.exit(1); } });

const AUTHORIZED_USER = parseInt(process.env.AUTHORIZED_USER_ID);
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const pending = {};

// Tope de gasto en USD (equivalente en soles según TC)
const TOPE_USD = parseFloat(process.env.TOPE_USD || "5");
const TC_SOLES = parseFloat(process.env.TC_SOLES || "3.75"); // Tipo de cambio
const TOPE_SOLES = TOPE_USD * TC_SOLES;

console.log(`🤖 FinTrack Bot iniciado! Tope: $${TOPE_USD} USD = S/${TOPE_SOLES}`);

const auth = msg => msg.from?.id === AUTHORIZED_USER;
const deny = id => bot.sendMessage(id, "⛔ No autorizado.");
const cur = (n, currency) => currency === "USD" ? `$${parseFloat(n||0).toFixed(2)}` : `S/ ${parseFloat(n||0).toFixed(2)}`;
const fecha = iso => !iso ? "—" : new Date(iso+"T00:00:00").toLocaleDateString("es-PE",{day:"2-digit",month:"short",year:"numeric"});

function buildMsg(d, uid) {
  const moneda = d.currency === "USD" ? "💵" : "💰";
  return (`✅ *Transacción registrada*\n\n` +
    `🔑 \`${uid}\`\n` +
    `${moneda} *${cur(d.amount, d.currency)}*\n` +
    `📅 ${fecha(d.date)}\n` +
    `👤 ${d.recipient||"—"}\n` +
    `📝 ${d.description||"—"}\n` +
    `💳 ${d.method||"—"}\n` +
    `🏷️ ${d.category||"—"}` +
    `${d.notes ? `\n🔢 ${d.notes}` : ""}`
  ).trim();
}

async function checkTope(chatId, newAmount, currency) {
  try {
    const { total } = await getSummary(30);
    // Convertir nuevo monto a soles para comparar
    const nuevoEnSoles = currency === "USD" ? newAmount * TC_SOLES : newAmount;
    const totalConNuevo = total + nuevoEnSoles;
    const porcentaje = Math.round((totalConNuevo / TOPE_SOLES) * 100);

    if (totalConNuevo >= TOPE_SOLES) {
      await bot.sendMessage(chatId,
        `🚨 *¡TOPE DE GASTO SUPERADO!*\n\n` +
        `Has gastado *S/ ${totalConNuevo.toFixed(2)}* este mes\n` +
        `Tu tope es *$${TOPE_USD} USD = S/ ${TOPE_SOLES.toFixed(2)}*\n\n` +
        `⚠️ Considera revisar tus gastos.`,
        { parse_mode: "Markdown" }
      );
    } else if (porcentaje >= 80) {
      await bot.sendMessage(chatId,
        `⚠️ *Atención: ${porcentaje}% de tu tope*\n\n` +
        `Llevas *S/ ${totalConNuevo.toFixed(2)}* de *S/ ${TOPE_SOLES.toFixed(2)}* este mes\n` +
        `Te quedan *S/ ${(TOPE_SOLES - totalConNuevo).toFixed(2)}*`,
        { parse_mode: "Markdown" }
      );
    }
  } catch(e) {
    console.error("Error check tope:", e.message);
  }
}

// ── COMANDOS ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, m => {
  if (!auth(m)) return deny(m.chat.id);
  bot.sendMessage(m.chat.id,
    `👋 *¡Bienvenido a FinTrack!*\n\n` +
    `Envíame una foto 📷 de tu comprobante y lo registro automáticamente.\n\n` +
    `*Comandos:*\n` +
    `/resumen — Gastos del mes\n` +
    `/tope — Ver tu tope de gasto\n` +
    `/excel — Descargar reporte Excel\n` +
    `/ayuda — Ayuda`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/ayuda/, m => {
  if (!auth(m)) return deny(m.chat.id);
  bot.sendMessage(m.chat.id,
    `📖 *Cómo usar FinTrack*\n\n` +
    `Envía cualquier foto de comprobante:\n` +
    `• Yape / Plin\n• Transferencias BBVA/BCP\n• Facturas y boletas\n• Recibos físicos\n• Vouchers de pago\n\n` +
    `La IA extrae todo automáticamente 🤖`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/tope/, async m => {
  if (!auth(m)) return deny(m.chat.id);
  try {
    const { total, count } = await getSummary(30);
    const porcentaje = Math.round((total / TOPE_SOLES) * 100);
    const restante = TOPE_SOLES - total;
    const barra = "█".repeat(Math.min(Math.round(porcentaje/10), 10)) + "░".repeat(Math.max(10 - Math.round(porcentaje/10), 0));
    bot.sendMessage(m.chat.id,
      `📊 *Tu tope de gasto*\n\n` +
      `${barra} ${porcentaje}%\n\n` +
      `💰 Gastado: *S/ ${total.toFixed(2)}*\n` +
      `🎯 Tope: *$${TOPE_USD} = S/ ${TOPE_SOLES.toFixed(2)}*\n` +
      `✅ Restante: *S/ ${Math.max(restante, 0).toFixed(2)}*\n` +
      `📋 Transacciones: *${count}*`,
      { parse_mode: "Markdown" }
    );
  } catch(e) { bot.sendMessage(m.chat.id, "❌ Error."); }
});

bot.onText(/\/resumen/, async m => {
  if (!auth(m)) return deny(m.chat.id);
  try {
    const { total, count, byCategory } = await getSummary(30);
    if (count === 0) return bot.sendMessage(m.chat.id, "📭 Sin transacciones este mes.");
    const lines = Object.entries(byCategory).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`  • ${c}: *S/ ${v.toFixed(2)}*`).join("\n");
    const porcentaje = Math.round((total / TOPE_SOLES) * 100);
    bot.sendMessage(m.chat.id,
      `📊 *Resumen del mes*\n\n` +
      `💰 Total: *S/ ${total.toFixed(2)}*\n` +
      `📋 Transacciones: *${count}*\n` +
      `🎯 Tope: ${porcentaje}% usado\n\n` +
      `*Por categoría:*\n${lines}`,
      { parse_mode: "Markdown" }
    );
  } catch(e) { bot.sendMessage(m.chat.id, "❌ Error."); }
});

bot.onText(/^(\/excel|excel)$/i, async m => {
  if (!auth(m)) return deny(m.chat.id);
  const p = await bot.sendMessage(m.chat.id, "⏳ Generando Excel...");
  try {
    const txs = await getTransactionsSince(15);
    if (txs.length === 0) return bot.editMessageText("📭 Sin transacciones.", { chat_id: m.chat.id, message_id: p.message_id });
    const fp = generateExcel(txs);
    await bot.deleteMessage(m.chat.id, p.message_id);
    await bot.sendDocument(m.chat.id, fp, {
      caption: `📊 *Reporte FinTrack* — ${txs.length} transacciones · S/ ${txs.reduce((s,t)=>s+parseFloat(t.amount||0),0).toFixed(2)}`,
      parse_mode: "Markdown"
    });
    fs.unlinkSync(fp);
  } catch(e) { bot.sendMessage(m.chat.id, "❌ Error al generar Excel."); }
});

// ── PROCESAR FOTO ─────────────────────────────────────────────────────────────

async function procesarComprobante(chatId, fileId, imageUrl, caption = null) {
  const p = await bot.sendMessage(chatId, "🔍 Leyendo comprobante con IA...");
  try {
    const extracted = await extractFromImage(imageUrl);
    if (!extracted) {
      await bot.editMessageText(
        "⚠️ No pude leer el comprobante.\n\nEnvía los datos así:\n`MONTO|DESTINATARIO|DESCRIPCION`\nEjemplo: `45.50|Tambo|Desayuno`",
        { chat_id: chatId, message_id: p.message_id, parse_mode: "Markdown" }
      );
      pending[chatId] = { imageUrl, waitingManual: true };
      return;
    }
    if (caption) extracted.notes = extracted.notes ? extracted.notes + ' | ' + caption : caption;
    const saved = await saveTransaction({ ...extracted, image_url: imageUrl });
    await bot.editMessageText(buildMsg(saved, saved.uid), { chat_id: chatId, message_id: p.message_id, parse_mode: "Markdown" });
    // Verificar tope después de guardar
  } catch(e) {
    console.error(e);
    bot.editMessageText("❌ Error al procesar.", { chat_id: chatId, message_id: p.message_id });
  }
}

bot.on("photo", async m => {
  if (!auth(m)) return deny(m.chat.id);
  const fi = await bot.getFile(m.photo[m.photo.length - 1].file_id);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fi.file_path}`;
  await procesarComprobante(m.chat.id, m.photo[m.photo.length - 1].file_id, url, m.caption || null);
});

bot.on("document", async m => {
  if (!auth(m)) return deny(m.chat.id);
  const doc = m.document;
  if (!doc.mime_type || !doc.mime_type.startsWith("image/")) {
    return bot.sendMessage(m.chat.id, "⚠️ Solo proceso imágenes. Envía JPG o PNG.");
  }
  const fi = await bot.getFile(doc.file_id);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fi.file_path}`;
  await procesarComprobante(m.chat.id, doc.file_id, url, m.caption || null);
});

// ── INGRESO MANUAL ────────────────────────────────────────────────────────────

bot.on("message", async m => {
  if (!auth(m) || m.photo || m.document || m.text?.startsWith("/")) return;
  const p = pending[m.chat.id];
  if (p?.waitingManual && m.text) {
    const parts = m.text.split("|").map(s => s.trim());
    if (parts.length < 2 || isNaN(parseFloat(parts[0]))) {
      return bot.sendMessage(m.chat.id, "❌ Formato: `MONTO|DESTINATARIO|DESCRIPCION`", { parse_mode: "Markdown" });
    }
    try {
      const saved = await saveTransaction({
        amount: parseFloat(parts[0]), recipient: parts[1] || "Manual",
        description: parts[2] || "Ingreso manual", currency: "PEN",
        date: new Date().toISOString().slice(0, 10), method: "Otro", category: "Otro",
        image_url: p.imageUrl || null
      });
      delete pending[m.chat.id];
      bot.sendMessage(m.chat.id, buildMsg(saved, saved.uid), { parse_mode: "Markdown" });
    } catch(e) { bot.sendMessage(m.chat.id, "❌ Error al guardar."); }
  }
});

// ── REPORTE QUINCENAL AUTOMÁTICO ──────────────────────────────────────────────

cron.schedule("0 8 1,16 * *", async () => {
  try {
    const txs = await getTransactionsSince(15);
    if (txs.length === 0) return bot.sendMessage(AUTHORIZED_USER, "📭 Sin transacciones en los últimos 15 días.");
    const fp = generateExcel(txs);
    const total = txs.reduce((s,t) => s + parseFloat(t.amount||0), 0);
    await bot.sendMessage(AUTHORIZED_USER,
      `📊 *Reporte Quincenal Automático*\n✅ ${txs.length} transacciones\n💰 Total: *S/ ${total.toFixed(2)}*`,
      { parse_mode: "Markdown" }
    );
    await bot.sendDocument(AUTHORIZED_USER, fp, { caption: "📎 Reporte quincenal FinTrack" });
    fs.unlinkSync(fp);
  } catch(e) { console.error(e); }
}, { timezone: "America/Lima" });

bot.on("polling_error", e => console.error(e.message));
