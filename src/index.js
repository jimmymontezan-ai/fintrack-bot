require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
const fs = require("fs");
const { extractFromImage } = require("./gemini");
const { saveTransaction, getTransactionsSince, getSummary } = require("./database");
const { generateExcel } = require("./excel");

const required = ["TELEGRAM_BOT_TOKEN","AUTHORIZED_USER_ID","GEMINI_API_KEY","SUPABASE_URL","SUPABASE_ANON_KEY"];
required.forEach(k => { if (!process.env[k]) { console.error(`Falta: ${k}`); process.exit(1); } });

const AUTHORIZED_USER = parseInt(process.env.AUTHORIZED_USER_ID);
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const pending = {};
console.log("🤖 FinTrack Bot iniciado!");

const auth = msg => msg.from?.id === AUTHORIZED_USER;
const deny = id => bot.sendMessage(id, "⛔ No autorizado.");
const cur = n => `S/ ${parseFloat(n||0).toFixed(2)}`;
const fecha = iso => !iso ? "—" : new Date(iso+"T00:00:00").toLocaleDateString("es-PE",{day:"2-digit",month:"short",year:"numeric"});
const msg = (d,uid) => (`✅ *Transacción registrada*\n\n🔑 \`${uid}\`\n💰 *${cur(d.amount)}*\n📅 ${fecha(d.date)}\n👤 ${d.recipient||"—"}\n📝 ${d.description||"—"}\n💳 ${d.method||"—"}\n🏷️ ${d.category||"—"}${d.notes?`\n🔢 ${d.notes}`:""}`).trim();

bot.onText(/\/start/, m => { if(!auth(m)) return deny(m.chat.id); bot.sendMessage(m.chat.id,"👋 *¡Bienvenido a FinTrack!*\n\nEnvíame una 📷 foto de tu comprobante y lo registro automáticamente.\n\n/resumen — Gastos últimos 15 días\n/excel — Descargar reporte Excel",{parse_mode:"Markdown"}); });
bot.onText(/\/ayuda/, m => { if(!auth(m)) return deny(m.chat.id); bot.sendMessage(m.chat.id,"📖 Envía foto de tu comprobante y la IA extrae todo automáticamente.\n\n/resumen /excel",{parse_mode:"Markdown"}); });

bot.onText(/\/resumen/, async m => {
  if(!auth(m)) return deny(m.chat.id);
  try {
    const {total,count,byCategory} = await getSummary(15);
    if(count===0) return bot.sendMessage(m.chat.id,"📭 Sin transacciones en los últimos 15 días.");
    const lines = Object.entries(byCategory).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`  • ${c}: *${cur(v)}*`).join("\n");
    bot.sendMessage(m.chat.id,`📊 *Resumen — Últimos 15 días*\n\n💰 Total: *${cur(total)}*\n📋 Transacciones: *${count}*\n\n*Por categoría:*\n${lines}`,{parse_mode:"Markdown"});
  } catch(e) { bot.sendMessage(m.chat.id,"❌ Error."); }
});

bot.onText(/\/excel/, async m => {
  if(!auth(m)) return deny(m.chat.id);
  const p = await bot.sendMessage(m.chat.id,"⏳ Generando Excel...");
  try {
    const txs = await getTransactionsSince(15);
    if(txs.length===0) return bot.editMessageText("📭 Sin transacciones.",{chat_id:m.chat.id,message_id:p.message_id});
    const fp = generateExcel(txs);
    await bot.deleteMessage(m.chat.id,p.message_id);
    await bot.sendDocument(m.chat.id,fp,{caption:`📊 *Reporte FinTrack* — ${txs.length} transacciones · ${cur(txs.reduce((s,t)=>s+parseFloat(t.amount||0),0))}`,parse_mode:"Markdown"});
    fs.unlinkSync(fp);
  } catch(e) { bot.sendMessage(m.chat.id,"❌ Error al generar Excel."); }
});

bot.on("photo", async m => {
  if(!auth(m)) return deny(m.chat.id);
  const p = await bot.sendMessage(m.chat.id,"🔍 Analizando comprobante con IA...");
  try {
    const fi = await bot.getFile(m.photo[m.photo.length-1].file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fi.file_path}`;
    const extracted = await extractFromImage(url);
    if(!extracted) {
      await bot.editMessageText("⚠️ No pude leer el comprobante.\n\nEnvía los datos manualmente:\n`MONTO|DESTINATARIO|DESCRIPCION`\nEjemplo: `45.50|Tambo|Desayuno`",{chat_id:m.chat.id,message_id:p.message_id,parse_mode:"Markdown"});
      pending[m.chat.id]={imageUrl:url,waitingManual:true};
      return;
    }
    const saved = await saveTransaction({...extracted,image_url:url});
    await bot.editMessageText(msg(saved,saved.uid),{chat_id:m.chat.id,message_id:p.message_id,parse_mode:"Markdown"});
  } catch(e) { console.error(e); bot.editMessageText("❌ Error.",{chat_id:m.chat.id,message_id:p.message_id}); }
});

bot.on("message", async m => {
  if(!auth(m)||m.photo||m.text?.startsWith("/")) return;
  const p = pending[m.chat.id];
  if(p?.waitingManual && m.text) {
    const parts = m.text.split("|").map(s=>s.trim());
    if(parts.length<2||isNaN(parseFloat(parts[0]))) return bot.sendMessage(m.chat.id,"❌ Formato: `MONTO|DESTINATARIO|DESCRIPCION`",{parse_mode:"Markdown"});
    try {
      const saved = await saveTransaction({amount:parseFloat(parts[0]),recipient:parts[1]||"Manual",description:parts[2]||"Ingreso manual",date:new Date().toISOString().slice(0,10),method:"Otro",category:"Otro",image_url:p.imageUrl||null});
      delete pending[m.chat.id];
      bot.sendMessage(m.chat.id,msg(saved,saved.uid),{parse_mode:"Markdown"});
    } catch(e) { bot.sendMessage(m.chat.id,"❌ Error al guardar."); }
  }
});

cron.schedule("0 8 1,16 * *", async () => {
  try {
    const txs = await getTransactionsSince(15);
    if(txs.length===0) return bot.sendMessage(AUTHORIZED_USER,"📭 Sin transacciones en los últimos 15 días.");
    const fp = generateExcel(txs);
    const total = txs.reduce((s,t)=>s+parseFloat(t.amount||0),0);
    await bot.sendMessage(AUTHORIZED_USER,`📊 *Reporte Quincenal Automático*\n✅ ${txs.length} transacciones\n💰 Total: *${cur(total)}*`,{parse_mode:"Markdown"});
    await bot.sendDocument(AUTHORIZED_USER,fp,{caption:"📎 Reporte quincenal FinTrack"});
    fs.unlinkSync(fp);
  } catch(e) { console.error(e); }
},{timezone:"America/Lima"});

bot.on("polling_error", e => console.error(e.message));
