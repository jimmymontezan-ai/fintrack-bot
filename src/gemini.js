const axios = require("axios");

const CATEGORIAS = "Alimentacion|Transporte|Vivienda|Servicios|Entretenimiento|Salud|Educacion|Otros Gastos";

const PROMPT = `Eres un experto OCR de comprobantes peruanos. Extrae datos de la imagen con maxima precision.
RECONOCES: Yape, Plin, Transferencias BBVA/BCP/Interbank, Facturas, Boletas, Recibos fisicos, Vouchers, Tickets de compra.
REGLAS: S/=Soles(PEN), $=Dolares(USD). Busca el monto TOTAL, nunca comisiones. Para Yape el numero grande es el monto.
RESPONDE SOLO JSON sin texto extra:
{"amount":<numero>,"currency":"<PEN o USD>","date":"<YYYY-MM-DD>","recipient":"<nombre>","description":"<que fue>","method":"<Yape|Plin|Transferencia|Tarjeta|Efectivo|Otro>","category":"<${CATEGORIAS}>","notes":"<numero operacion o null>"}`;

async function extractFromImage(imageUrl) {
  try {
    const response = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 15000 });
    const base64 = Buffer.from(response.data).toString("base64");
    let mimeType = (response.headers["content-type"] || "image/jpeg").split(";")[0].trim();
    if (!["image/jpeg","image/png","image/gif","image/webp"].includes(mimeType)) mimeType = "image/jpeg";
    const result = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
          { type: "text", text: PROMPT }
        ]}]
      },
      { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 30000 }
    );
    const raw = result.data.content[0].text.trim();
    const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
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
      category: data.category || "Otros Gastos",
      notes: data.notes || null,
    };
  } catch (err) {
    console.error("Error extraccion:", err.response?.data ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

// Interpreta un texto libre del usuario y actualiza las transacciones recientes
async function interpretContext(transactions, contextText) {
  try {
    const txList = transactions.map(t => ({
      id: t.id,
      amount: t.amount,
      currency: t.currency || "PEN",
      recipient: t.recipient,
      description: t.description,
      category: t.category,
    }));

    const prompt = `Tienes estas transacciones registradas recientemente:
${JSON.stringify(txList, null, 2)}

El usuario envio este mensaje con detalles adicionales:
"${contextText}"

Basandote en el mensaje del usuario, actualiza la descripcion, categoria y/o notas de cada transaccion mencionada.
- Usa SOLO estas categorias: ${CATEGORIAS}
- Infiere por el monto o destinatario a cual transaccion se refiere
- Si el texto no menciona una transaccion, no la incluyas
- La descripcion debe ser corta y clara (ej: "Vitaminas salud Jimmy Jr")

RESPONDE SOLO con un array JSON sin texto extra:
[{"id": <numero_id>, "description": "<nueva_descripcion>", "category": "<categoria>", "notes": "<notas_o_null>"}]
`;

    const result = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }]
      },
      { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 30000 }
    );
    const raw = result.data.content[0].text.trim();
    const start = raw.indexOf("["); const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("No JSON array");
    return JSON.parse(raw.substring(start, end + 1));
  } catch (err) {
    console.error("Error interpretContext:", err.message);
    return [];
  }
}

module.exports = { extractFromImage, interpretContext };
