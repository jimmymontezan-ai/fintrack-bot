const axios = require("axios");

const PROMPT = `Eres un experto OCR especializado en comprobantes de pago peruanos. Extrae los datos con MAXIMA PRECISION sin importar el tipo, fondo, color, calidad o formato de la imagen.

TIPOS QUE RECONOCES:
1. YAPE (morado): "Yapeaste!" - monto grande S/, campo Contacto, Nro. de operacion
2. PLIN (azul/verde): "Enviaste!" - similar a Yape
3. TRANSFERENCIA BBVA/BCP/INTERBANK/SCOTIABANK: "Operacion exitosa" - usa campo "Importe transferido" o "Importe enviado" como monto, NO uses comisiones ni ITF, destinatario es la cuenta destino, Numero de operacion
4. FACTURA ELECTRONICA F001/F002: campo Total, Razon Social cliente, numero de factura como nota
5. BOLETA DE VENTA: IMPORTE TOTAL A PAGAR o Total
6. RECIBO MANUAL papel fisico: monto escrito, nombre, concepto del pago, numero de recibo
7. VOUCHER PAGO TASAS/RENIEC/SUNAT: campo MONTO, entidad receptora, referencia
8. TICKET COMPRA/ENTRETENIMIENTO: Importe total, nombre tienda/sede
9. BOLETA DE ENVIO COURIER (Movil Cargo, Olva, etc): IMPORTE TOTAL A PAGAR, destinatario del envio

REGLAS CRITICAS:
- S/ = Soles peruanos (PEN)
- $ o USD = Dolares americanos (USD)
- Busca SIEMPRE el monto TOTAL final, nunca subtotales ni comisiones ni ITF
- Para transferencias: usa "Importe transferido" NO "Importe cargado"
- Para Yape: el numero grande es el monto correcto, ignora comision S/0.00
- Si la imagen es una captura de pantalla con fondos decorativos, ignora el fondo y lee solo el comprobante
- Fecha siempre en formato YYYY-MM-DD

CATEGORIAS (elige la mas apropiada):
- Alimentacion: restaurantes, supermercados, delivery, snacks
- Transporte: taxi, bus, combustible, envios, courier, encomiendas
- Servicios: luz, agua, internet, telefono, tasas, RENIEC, SUNAT, bancos
- Entretenimiento: cine, teatro, deporte, turismo, parques
- Salud: medicos, farmacias, clinicas, laboratorios, consultas
- Educacion: colegios, universidades, cursos, libros, utiles
- Trabajo: materiales, herramientas, fotochecks, servicios profesionales, impresiones
- Otro: todo lo demas

RESPONDE UNICAMENTE con JSON valido, sin texto antes ni despues, sin markdown, sin explicaciones:
{"amount":<numero decimal ej 150.00>,"currency":"<PEN o USD>","date":"<YYYY-MM-DD>","recipient":"<nombre completo destinatario o empresa>","description":"<que fue el pago, especifico>","method":"<Yape|Plin|Transferencia|Tarjeta|Efectivo|Otro>","category":"<categoria>","notes":"<numero de operacion o factura si existe, sino null>"}`;

async function extractFromImage(imageUrl) {
  try {
    // Descargar imagen
    const response = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 15000 });
    const base64 = Buffer.from(response.data).toString("base64");
    const mimeType = response.headers["content-type"] || "image/jpeg";

    // Llamar a Claude API
    const result = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mimeType, data: base64 }
              },
              {
                type: "text",
                text: PROMPT
              }
            ]
          }
        ]
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
    console.error("Error Claude extraccion:", err.message);
    return null;
  }
}

module.exports = { extractFromImage };
