const axios = require("axios");

const PROMPT = `Eres un experto OCR de comprobantes peruanos. Extrae datos de la imagen con maxima precision.

RECONOCES: Yape, Plin, Transferencias BBVA/BCP/Interbank, Facturas, Boletas, Recibos fisicos, Vouchers RENIEC/SUNAT, Tickets de compra.

REGLAS: S/=Soles(PEN), $=Dolares(USD). Busca el monto TOTAL, nunca comisiones. Para Yape el numero grande es el monto.

RESPONDE SOLO JSON sin texto extra:
{"amount":<numero>,"currency":"<PEN o USD>","date":"<YYYY-MM-DD>","recipient":"<nombre>","description":"<que fue>","method":"<Yape|Plin|Transferencia|Tarjeta|Efectivo|Otro>","category":"<Alimentacion|Transporte|Servicios|Entretenimiento|Salud|Educacion|Trabajo|Otro>","notes":"<numero operacion o null>"}`;

async function extractFromImage(imageUrl) {
  try {
    const response = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 15000 });
    const base64 = Buffer.from(response.data).toString("base64");
    const mimeType = response.headers["content-type"] || "image/jpeg";

    const result = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
            { type: "text", text: PROMPT }
          ]
        }]
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        timeout: 30000
      }
    );

    const raw = result.data.content[0].text.trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON");
    const data = JSON.parse(raw.substring(start, end + 1));
    if (!data.amount || isNaN(parseFloat(data.amount))) throw new Error("Monto invalido");

    return {
      amount: parseFloat(data.amount),
      currency: data.currency || "PEN",
      date: data.date || new Date().toISOString().slice(0, 10),
      recipient: data.recipient || "Sin destinatario",
      description: data.description || "Sin descripcion",
      method: data.method || "Otro",
      category: data.category || "Otro",
      notes: data.notes || null,
    };
  } catch (err) {
    console.error("Error Claude extraccion:", err.message);
    return null;
  }
}

module.exports = { extractFromImage };
