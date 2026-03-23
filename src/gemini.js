const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const PROMPT = `Eres un extractor de datos de comprobantes de pago peruanos. Analiza esta imagen (Yape, Plin, transferencia, factura, boleta o recibo). Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional: {"amount":<número decimal en soles>,"date":"<YYYY-MM-DD>","recipient":"<destinatario o comercio>","description":"<descripción breve>","method":"<Yape|Plin|Transferencia|Tarjeta|Efectivo|Otro>","category":"<Alimentación|Transporte|Servicios|Entretenimiento|Salud|Educación|Trabajo|Otro>","notes":"<número de operación u otro detalle, o null>"}`;
async function urlToBase64(url) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return { base64: Buffer.from(response.data).toString("base64"), mimeType: response.headers["content-type"] || "image/jpeg" };
}
async function extractFromImage(imageUrl) {
  try {
    const { base64, mimeType } = await urlToBase64(imageUrl);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent([PROMPT, { inlineData: { mimeType, data: base64 } }]);
    const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
    const data = JSON.parse(raw);
    if (!data.amount || isNaN(parseFloat(data.amount))) throw new Error("Monto no detectado");
    return { amount: parseFloat(data.amount), date: data.date || new Date().toISOString().slice(0,10), recipient: data.recipient || "Sin destinatario", description: data.description || "Sin descripción", method: data.method || "Otro", category: data.category || "Otro", notes: data.notes || null };
  } catch (err) { console.error("Error Gemini:", err.message); return null; }
}
module.exports = { extractFromImage };
