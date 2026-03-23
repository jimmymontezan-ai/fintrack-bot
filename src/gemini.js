const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PROMPT = `Eres un experto OCR especializado en comprobantes de pago peruanos. Debes extraer datos con MAXIMA PRECISION sin importar el tipo, fondo, color, iluminacion o calidad de la imagen.

TIPOS DE COMPROBANTES:
1. YAPE (morado): "Yapeaste!" - monto grande, campo Contacto, Nro. de operacion
2. PLIN (azul/verde): "Enviaste!" - similar a Yape
3. TRANSFERENCIA BBVA/BCP/INTERBANK: "Operacion exitosa" - usa "Importe transferido" NO comisiones, nombre cuenta destino, Numero de operacion
4. FACTURA ELECTRONICA F001/F002: campo Total, Razon Social cliente, numero de factura
5. BOLETA DE VENTA: IMPORTE TOTAL A PAGAR
6. RECIBO MANUAL: papel fisico, monto escrito, nombre y concepto
7. VOUCHER PAGO TASAS/RENIEC/SUNAT: campo MONTO, entidad receptora
8. TICKET COMPRA/ENTRETENIMIENTO: Importe total, nombre tienda

REGLAS:
- S/ = Soles PEN, $ o USD = Dolares USD
- Busca SIEMPRE el monto TOTAL, nunca subtotales ni comisiones
- Yape: el numero grande es el monto, ignora S/0.00 de comision
- Fecha formato YYYY-MM-DD

CATEGORIAS: Alimentacion|Transporte|Servicios|Entretenimiento|Salud|Educacion|Trabajo|Otro

RESPONDE SOLO con JSON sin texto adicional:
{"amount":<numero>,"currency":"<PEN o USD>","date":"<YYYY-MM-DD>","recipient":"<nombre>","description":"<que fue>","method":"<Yape|Plin|Transferencia|Tarjeta|Efectivo|Otro>","category":"<categoria>","notes":"<numero operacion>"}`;

async function urlToBase64(url) {
  const response = await axios.get(url, { responseType: "arraybuffer", timeout: 15000 });
  return { base64: Buffer.from(response.data).toString("base64"), mimeType: response.headers["content-type"] || "image/jpeg" };
}

async function extractFromImage(imageUrl) {
  try {
    const { base64, mimeType } = await urlToBase64(imageUrl);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent([PROMPT, { inlineData: { mimeType, data: base64 } }]);
    const raw = result.response.text().trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON encontrado");
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
    console.error("Error Gemini:", err.message);
    return null;
  }
}

module.exports = { extractFromImage };
