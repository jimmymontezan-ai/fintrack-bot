require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
const fs = require("fs");
const { extractFromImage, interpretContext } = require("./gemini");
const { saveTransaction, updateTransaction, getTransactionsSince, getAllTransactions, getSummary } = require("./database");
const { generateExcel } = require("./excel");

const required = ["TELEGRAM_BOT_TOKEN","AUTHORIZED_USER_ID","ANTHROPIC_API_KEY","SUPABASE_URL","SUPABASE_ANON_KEY"];
required.forEach(k => { if (!process.env[k]) { console.error(`Falta: ${k}`); process.exit(1); } });

const AUTHORIZED_USER = parseInt(process.env.AUTHORIZED_USER_ID);
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const pending = {};

const TOPE_USD = parseFloat(process.env.TOPE_USD || "5");
const TC_SOLES = parseFloat(process.env.TC_SOLES || "3.75");
const TOPE_SOLES = TOPE_USD * TC_SOLES;

// Buffer de transacciones recientes para aplicar contexto
let recentTxBuffer = [];
let recentTxTimer = null;
const RECENT_TX_TTL = 10 * 60 * 1000; // 10 minutos

// FIX 1: contexto pendiente cuando texto llega antes de que la foto termine de procesarse
const pendingContext = {}; // chatId -> { texto, ts }
const processingPhoto = {}; // chatId -> true mientras se procesa una foto

function pushRecentTx(tx) {
  recentTxBuffer.push(tx);
  if (recentTxTimer) clearTimeout(recentTxTimer);
  recentTxTimer = setTimeout(() => {
    recentTxBuffer = [];
    recentTxTimer = null;
  }, RECENT_TX_TTL);
}

console.log(`🤖 FinTrack Bot iniciado! Tope: $${TOPE_USD} USD = S/${TOPE_SOLES}`);

const auth = msg => msg.from?.id === AUTHORIZED_USER;
const deny = id => bot.sendMessage(id, "⛔ No autorizado.");
const cur = (n, currency) => currency === "USD" ? `$${parseFloat(n||0).toFixed(2)}` : `S/ ${parseFloat(n||0).toFixed(2)}`;
const fecha = iso => !iso ? "—" : new Date(iso+"T00:00:00").toLocaleDateString("es-PE",{day:"2-digit",month:"short",year:"numeric"});

function buildMsg(d, uid) {
  const moneda = d.currency === "USD" ? "💵" : "💰";
  return [
    `✅ *Transacción registrada*`,
    `🔑 ID: \`${uid}\``,
    `${moneda} Monto: *${cur(d.amount, d.currency)}*`,
    `📅 Fecha: ${fecha(d.date)}`,
    `👤 Destinatario: ${d.recipient||"—"}`,
    `📝 Descripción: ${d.description||"—"}`,
    `💳 Método: ${d.method||"—"}`,
    `🏷️ Categoría: ${d.category||"—"}`,
    ...(d.notes ? [`🔢 Ref: ${d.notes}`] : [])
  ].join("\n");
}

// ── COMANDOS ────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, m => {
  if (!auth(m)) return deny(m.chat.id);
  bot.sendMessage(m.chat.id, `👋 *¡Bienvenido a FinTrack!*

Envíame una foto 📷 de tu comprobante y lo registro automáticamente.
Después de las fotos, puedes enviar un texto con detalles adicionales y lo actualizo.

*Comandos:*
/resumen — Gastos del mes
/tope — Ver tu tope de gasto
/excel — Descargar reporte Excel
/ayuda — Ayuda`, { parse_mode: "Markdown" });
});

bot.onText(/\/ayuda/, m => {
  if (!auth(m)) return deny(m.chat.id);
  bot.sendMessage(m.chat.id, `📖 *Cómo usar FinTrack*

Envía cualquier foto de comprobante:
• Yape / Plin
• Transferencias BBVA/BCP
• Facturas y boletas
• Recibos físicos
• Vouchers de pago

La IA extrae todo automáticamente 🤖

💡 *Tip:* Después de enviar las fotos, manda un texto con detalles y actualizo las transacciones.`, { parse_mode: "Markdown" });
});

bot.onText(/\/tope/, async m => {
  if (!auth(m)) return deny(m.chat.id);
  try {
    const { total, count } = await getSummary(30);
    const porcentaje = Math.round((total / TOPE_SOLES) * 100);
    const restante = TOPE_SOLES - total;
    const barra = "█".repeat(Math.min(Math.round(porcentaje/10), 10)) + "░".repeat(Math.max(10 - Math.round(porcentaje/10), 0));
    bot.sendMessage(m.chat.id, `📊 *Tu tope de gasto*

${barra} ${porcentaje}%

💰 Gastado: *S/ ${total.toFixed(2)}*
🎯 Tope: *$${TOPE_USD} = S/ ${TOPE_SOLES.toFixed(2)}*
✅ Restante: *S/ ${Math.max(restante, 0).toFixed(2)}*
📋 Transacciones: *${count}*`, { parse_mode: "Markdown" });
  } catch(e) {
    bot.sendMessage(m.chat.id, "❌ Error.");
  }
});

bot.onText(/\/resumen/, async m => {
  if (!auth(m)) return deny(m.chat.id);
  try {
    const { total, count, byCategory } = await getSummary(30);
    if (count === 0) return bot.sendMessage(m.chat.id, "📭 Sin transacciones este mes.");
    const lines = Object.entries(byCategory).sort((a,b)=>b[1]-a[1]).map(([c,v])=>` • ${c}: *S/ ${v.toFixed(2)}*`).join("\n");
    const porcentaje = Math.round((total / TOPE_SOLES) * 100);
    bot.sendMessage(m.chat.id, `📊 *Resumen del mes*

💰 Total: *S/ ${total.toFixed(2)}*
📋 Transacciones: *${count}*
🎯 Tope: ${porcentaje}% usado

*Por categoría:*
${lines}`, { parse_mode: "Markdown" });
  } catch(e) {
    bot.sendMessage(m.chat.id, "❌ Error.");
  }
});

bot.onText(/^(\/excel|excel)$/i, async m => {
  if (!auth(m)) return deny(m.chat.id);
  const p = await bot.sendMessage(m.chat.id, "⏳ Generando Excel...");
  try {
    const txs = await getAllTransactions();
    if (txs.length === 0) return bot.editMessageText("📭 Sin transacciones.", { chat_id: m.chat.id, message_id: p.message_id });
    const fp = await generateExcel(txs);
    await bot.deleteMessage(m.chat.id, p.message_id);
    await bot.sendDocument(m.chat.id, fp, {
      caption: `📊 *Reporte FinTrack* — ${txs.length} transacciones · S/ ${txs.reduce((s,t)=>s+parseFloat(t.amount||0),0).toFixed(2)}`,
      parse_mode: "Markdown"
    });
    fs.unlinkSync(fp);
  } catch(e) {
    bot.sendMessage(m.chat.id, "❌ Error al generar Excel.");
  }
});

// ── PROCESAR COMPROBANTE ──────────────────────────────────────────────────────
async function procesarComprobante(chatId, fileId, imageUrl, caption = null) {
  processingPhoto[chatId] = true; // FIX 1: marcar que estamos procesando
  const p = await bot.sendMessage(chatId, "🔍 Leyendo comprobante con IA...");
  try {
    const extracted = await extractFromImage(imageUrl);
    if (!extracted) {
      delete processingPhoto[chatId];
      await bot.editMessageText(
        "⚠️ No pude leer el comprobante.\n\nEnvía los datos así:\n`MONTO|DESTINATARIO|DESCRIPCION`\nEjemplo: `45.50|Tambo|Desayuno`",
        { chat_id: chatId, message_id: p.message_id, parse_mode: "Markdown" }
      );
      pending[chatId] = { imageUrl, waitingManual: true };
      return;
    }
    if (caption) extracted.notes = extracted.notes ? extracted.notes + " | " + caption : caption;
    const saved = await saveTransaction({ ...extracted, image_url: imageUrl });
    pushRecentTx(saved);
    delete processingPhoto[chatId]; // FIX 1: desmarcar antes de responder
    await bot.editMessageText(buildMsg(saved, saved.uid), {
      chat_id: chatId,
      message_id: p.message_id,
      parse_mode: "Markdown"
    });
    // FIX 2: eliminado checkTope — ya no se envía alerta automática de tope
    // FIX 1: si el usuario mandó contexto mientras esperaba, aplicarlo ahora
    if (pendingContext[chatId] && (Date.now() - pendingContext[chatId].ts) < 5 * 60 * 1000) {
      const ctx = pendingContext[chatId].texto;
      delete pendingContext[chatId];
      await procesarContexto(chatId, ctx);
    }
  } catch(e) {
    delete processingPhoto[chatId];
    console.error(e);
    bot.editMessageText("❌ Error al procesar.", { chat_id: chatId, message_id: p.message_id });
  }
}

// ── APLICAR CONTEXTO DE TEXTO ─────────────────────────────────────────────────
async function procesarContexto(chatId, texto) {
  const txsToUpdate = [...recentTxBuffer];
  recentTxBuffer = [];
  if (recentTxTimer) { clearTimeout(recentTxTimer); recentTxTimer = null; }
  const p = await bot.sendMessage(chatId, "✏️ Actualizando transacciones con tu contexto...");
  try {
    const updates = await interpretContext(txsToUpdate, texto);
    if (!updates || updates.length === 0) {
      await bot.editMessageText("ℹ️ No pude relacionar el texto con las transacciones recientes.", { chat_id: chatId, message_id: p.message_id });
      return;
    }
    const lines = [];
    for (const upd of updates) {
      if (!upd.id) continue;
      try {
        const row = await updateTransaction(upd.id, {
          description: upd.description,
          category: upd.category,
          notes: upd.notes || null,
        });
        lines.push(`• ${cur(row.amount, row.currency)} — ${row.description} [*${row.category}*]`);
      } catch(e) {
        console.error("Error actualizando tx", upd.id, e.message);
      }
    }
    const msg = lines.length > 0
      ? `✅ *Actualizadas ${lines.length} transacción(es):*\n${lines.join("\n")}`
      : "⚠️ No se pudo actualizar ninguna transacción.";
    await bot.editMessageText(msg, { chat_id: chatId, message_id: p.message_id, parse_mode: "Markdown" });
  } catch(e) {
    console.error("Error procesarContexto:", e.message);
    bot.editMessageText("❌ Error al procesar el contexto.", { chat_id: chatId, message_id: p.message_id });
  }
}

// ── HANDLERS DE FOTOS Y DOCUMENTOS ───────────────────────────────────────────
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

// ── MENSAJES DE TEXTO ─────────────────────────────────────────────────────────
bot.on("message", async m => {
  if (!auth(m) || m.photo || m.document || m.text?.startsWith("/")) return;
  const texto = m.text?.trim();
  if (!texto) return;

  // Bypass: "excel" tiene su propio handler, no pasar a contexto
  if (/^(excel)$/i.test(texto)) return;

  // Si hay transacciones recientes en buffer → aplicar como contexto
  if (recentTxBuffer.length > 0) {
    return procesarContexto(m.chat.id, texto);
  }

  // FIX 1: si se está procesando una foto, guardar texto para aplicarlo después
  if (processingPhoto[m.chat.id]) {
    pendingContext[m.chat.id] = { texto, ts: Date.now() };
    return;
  }

  // Ingreso manual después de fallo de OCR
  const p = pending[m.chat.id];
  if (p?.waitingManual) {
    const parts = texto.split("|").map(s => s.trim());
    if (parts.length < 2 || isNaN(parseFloat(parts[0]))) {
      return bot.sendMessage(m.chat.id, "❌ Formato: `MONTO|DESTINATARIO|DESCRIPCION`", { parse_mode: "Markdown" });
    }
    try {
      const saved = await saveTransaction({
        amount: parseFloat(parts[0]),
        recipient: parts[1] || "Manual",
        description: parts[2] || "Ingreso manual",
        currency: "PEN",
        date: new Date().toISOString().slice(0, 10),
        method: "Otro",
        category: "Otros Gastos",
        image_url: p.imageUrl || null,
      });
      delete pending[m.chat.id];
      pushRecentTx(saved);
      bot.sendMessage(m.chat.id, buildMsg(saved, saved.uid), { parse_mode: "Markdown" });
    } catch(e) {
      bot.sendMessage(m.chat.id, "❌ Error al guardar.");
    }
  }
});

// ── REPORTE QUINCENAL AUTOMÁTICO ──────────────────────────────────────────────
cron.schedule("0 8 1,16 * *", async () => {
  try {
    const txs = await getTransactionsSince(15);
    if (txs.length === 0) return bot.sendMessage(AUTHORIZED_USER, "📭 Sin transacciones en los últimos 15 días.");
    const fp = await generateExcel(txs);
    const total = txs.reduce((s,t) => s + parseFloat(t.amount||0), 0);
    await bot.sendMessage(AUTHORIZED_USER, `📊 *Reporte Quincenal Automático*

✅ ${txs.length} transacciones
💰 Total: *S/ ${total.toFixed(2)}*`, { parse_mode: "Markdown" });
    await bot.sendDocument(AUTHORIZED_USER, fp, { caption: "📎 Reporte quincenal FinTrack" });
    fs.unlinkSync(fp);
  } catch(e) { console.error(e); }
}, { timezone: "America/Lima" });

bot.on("polling_error", e => console.error(e.message));

// HTTP keepalive para Railway
const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end("fintrack-bot OK"); }).listen(PORT, () => console.log("Health server on port " + PORT));
