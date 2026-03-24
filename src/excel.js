const path = require("path");
const os = require("os");
const fs = require("fs");
const axios = require("axios");
const ExcelJS = require("exceljs");

const FIXED_CATEGORIES = [
  "Alimentacion",
  "Transporte",
  "Vivienda",
  "Servicios",
  "Entretenimiento",
  "Salud",
  "Educacion",
  "Otros Gastos",
];

const CATEGORY_COLORS = {
  Alimentacion: "FF6B6B",
  Transporte: "4ECDC4",
  Vivienda: "45B7D1",
  Servicios: "FFA07A",
  Entretenimiento: "98D8C8",
  Salud: "7EC8A4",
  Educacion: "F7DC6F",
  "Otros Gastos": "BB8FCE",
};

function getExtFromUrl(url) {
  if (!url) return "jpeg";
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "png";
  return "jpeg";
}

async function fetchImageBuffer(url) {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 12000,
    });
    return Buffer.from(response.data);
  } catch (_) {
    return null;
  }
}

function getImageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    for (let i = 0; i < Math.min(buf.length - 9, 65536); i++) {
      if (
        buf[i] === 0xff &&
        (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2 || buf[i + 1] === 0xc1)
      ) {
        return {
          w: buf.readUInt16BE(i + 7),
          h: buf.readUInt16BE(i + 5),
        };
      }
    }
  } catch (_) {}
  return { w: 300, h: 400 };
}

async function generateExcel(transactions) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "FinTrack Bot";
  wb.created = new Date();

  const ws1 = wb.addWorksheet("Transacciones");

  ws1.columns = [
    { header: "ID", key: "id", width: 8 },
    { header: "Fecha", key: "date", width: 14 },
    { header: "Monto", key: "amount", width: 14 },
    { header: "Moneda", key: "currency", width: 10 },
    { header: "Destinatario", key: "recipient", width: 22 },
    { header: "Descripcion", key: "description", width: 30 },
    { header: "Metodo", key: "method", width: 16 },
    { header: "Categoria", key: "category", width: 18 },
    { header: "Notas", key: "notes", width: 24 },
  ];

  const headerRow1 = ws1.getRow(1);
  headerRow1.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E79" },
    };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      bottom: { style: "medium", color: { argb: "FF2E75B6" } },
    };
  });
  headerRow1.height = 24;
  ws1.views = [{ state: "frozen", ySplit: 1 }];

  transactions.forEach((tx, i) => {
    const row = ws1.addRow({
      id: tx.id || i + 1,
      date: tx.date || "",
      amount: typeof tx.amount === "number" ? tx.amount : parseFloat(tx.amount) || 0,
      currency: tx.currency || "COP",
      recipient: tx.recipient || "",
      description: tx.description || "",
      method: tx.method || "",
      category: tx.category || "Otros Gastos",
      notes: tx.notes || "",
    });
    const even = i % 2 === 0;
    const bg = even ? "FFF0F4FA" : "FFFFFFFF";
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = {
        bottom: { style: "thin", color: { argb: "FFD0D8E0" } },
      };
    });
    row.getCell("amount").numFmt = "#,##0.00";
    row.getCell("amount").alignment = { horizontal: "right", vertical: "middle" };
    row.height = 18;
  });

  const ws2 = wb.addWorksheet("Resumen por Categoria");

  ws2.columns = [
    { header: "Categoria", key: "cat", width: 22 },
    { header: "Total Gastado", key: "total", width: 18 },
    { header: "% del Total", key: "pct", width: 14 },
    { header: "Grafico", key: "bar", width: 36 },
  ];

  const hRow2 = ws2.getRow(1);
  hRow2.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  hRow2.height = 24;

  const totals = {};
  FIXED_CATEGORIES.forEach((c) => { totals[c] = 0; });
  transactions.forEach((tx) => {
    const cat = tx.category || "Otros Gastos";
    const key = FIXED_CATEGORIES.includes(cat) ? cat : "Otros Gastos";
    totals[key] += typeof tx.amount === "number" ? tx.amount : parseFloat(tx.amount) || 0;
  });

  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);
  const maxVal = Math.max(...Object.values(totals), 1);
  const BAR_MAX = 20;

  FIXED_CATEGORIES.forEach((cat, i) => {
    const val = totals[cat];
    const pct = grandTotal > 0 ? (val / grandTotal) * 100 : 0;
    const filled = Math.round((val / maxVal) * BAR_MAX);
    const bar = "█".repeat(filled) + "░".repeat(BAR_MAX - filled);

    const row = ws2.addRow({ cat, total: val, pct: pct / 100, bar });

    const even = i % 2 === 0;
    const bg = even ? "FFF5F5F5" : "FFFFFFFF";
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
      cell.alignment = { vertical: "middle" };
      cell.border = { bottom: { style: "thin", color: { argb: "FFD0D8E0" } } };
    });

    row.getCell("total").numFmt = "#,##0.00";
    row.getCell("total").alignment = { horizontal: "right", vertical: "middle" };
    row.getCell("pct").numFmt = "0.0%";
    row.getCell("pct").alignment = { horizontal: "center", vertical: "middle" };

    const barCell = row.getCell("bar");
    const color = CATEGORY_COLORS[cat] || "AAAAAA";
    barCell.font = { color: { argb: "FF" + color }, name: "Courier New", size: 10 };
    barCell.alignment = { vertical: "middle" };
    row.height = 20;
  });

  const totalRow = ws2.addRow({ cat: "TOTAL", total: grandTotal, pct: 1, bar: "" });
  totalRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FF1F4E79" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD6E4F0" } };
    cell.alignment = { vertical: "middle" };
    cell.border = {
      top: { style: "medium", color: { argb: "FF2E75B6" } },
      bottom: { style: "medium", color: { argb: "FF2E75B6" } },
    };
  });
  totalRow.getCell("total").numFmt = "#,##0.00";
  totalRow.getCell("total").alignment = { horizontal: "right", vertical: "middle" };
  totalRow.getCell("pct").numFmt = "0.0%";
  totalRow.getCell("pct").alignment = { horizontal: "center", vertical: "middle" };
  totalRow.height = 22;
  ws2.views = [{ state: "frozen", ySplit: 1 }];

  const ws3 = wb.addWorksheet("Comprobantes");

  ws3.columns = [
    { header: "Fecha", key: "date", width: 14 },
    { header: "Info", key: "info", width: 30 },
    { header: "Comprobante", key: "img", width: 42 },
  ];

  const hRow3 = ws3.getRow(1);
  hRow3.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  hRow3.height = 24;
  ws3.views = [{ state: "frozen", ySplit: 1 }];

  const withImages = transactions.filter((tx) => tx.image_url);
  let currentRow = 2;

  for (const tx of withImages) {
    const infoText =
      (tx.date || "") + "\n" +
      (tx.recipient || "") + "\n" +
      (tx.currency || "COP") + " " + (parseFloat(tx.amount) || 0).toLocaleString("es-CO") + "\n" +
      (tx.category || "") + "\n" +
      (tx.description || "");

    const row = ws3.getRow(currentRow);
    row.getCell(1).value = tx.date || "";
    row.getCell(1).alignment = { vertical: "top", wrapText: true };
    row.getCell(2).value = infoText;
    row.getCell(2).alignment = { vertical: "top", wrapText: true };

    const buf = await fetchImageBuffer(tx.image_url);
    if (buf) {
      try {
        const { w, h } = getImageSize(buf);
        const maxW = 280;
        const scale = Math.min(1, maxW / w);
        const dispW = Math.round(w * scale);
        const dispH = Math.round(h * scale);

        const ext = getExtFromUrl(tx.image_url);
        const imgId = wb.addImage({ buffer: buf, extension: ext });

        ws3.addImage(imgId, {
          tl: { col: 2, row: currentRow - 1 },
          ext: { width: dispW, height: dispH },
          editAs: "oneCell",
        });

        row.height = Math.max(100, Math.round(dispH * 0.755));
      } catch (_) {
        row.getCell(3).value = "(imagen no disponible)";
        row.height = 60;
      }
    } else {
      row.getCell(3).value = "(sin comprobante)";
      row.height = 60;
    }

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber < 3) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAFAFA" } };
        cell.border = {
          bottom: { style: "thin", color: { argb: "FFD0D8E0" } },
          right: { style: "thin", color: { argb: "FFD0D8E0" } },
        };
      }
    });

    currentRow++;
  }

  if (withImages.length === 0) {
    ws3.getRow(2).getCell(1).value = "No hay comprobantes con imagen registrados.";
  }

  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `fintrack_${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

module.exports = { generateExcel };
