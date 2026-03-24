"use strict";
const ExcelJS = require("exceljs");
const axios   = require("axios");
const path    = require("path");

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("es-PE", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

const FIXED_CATEGORIES = [
  "Alimentacion", "Transporte", "Vivienda", "Servicios",
  "Entretenimiento", "Salud", "Educacion", "Otros Gastos",
];

async function fetchImageBuffer(url) {
  try {
    const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 12000 });
    return Buffer.from(resp.data);
  } catch { return null; }
}

function getExtFromUrl(url) {
  const m = (url || "").match(/\.(jpg|jpeg|png|gif|webp)/i);
  return m ? m[1].toLowerCase() : "jpeg";


// Parse PNG/JPEG dimensions from buffer without external deps
function getImageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) { // PNG
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    for (let i = 0; i < Math.min(buf.length - 9, 65536); i++) {
      if (buf[i] === 0xFF && (buf[i+1] === 0xC0 || buf[i+1] === 0xC2 || buf[i+1] === 0xC1)) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
    }
  } catch (_) {}
  return { w: 300, h: 400 };
}}

async function generateExcel(transactions) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "FinTrack";
  wb.created = new Date();

  const total = transactions.reduce((s, t) => s + parseFloat(t.amount || 0), 0);

  const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A56DB" } };
  const headerFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  const thin = { style: "thin" };
  const border = { top: thin, bottom: thin, left: thin, right: thin };

  // ── SHEET 1: Transacciones ──────────────────────────────────────────────
  const ws1 = wb.addWorksheet("Transacciones");
  ws1.columns = [
    { header: "#",            key: "num",         width: 5  },
    { header: "Código",       key: "uid",          width: 20 },
    { header: "Fecha",        key: "fecha",        width: 12 },
    { header: "Destinatario", key: "recipient",    width: 22 },
    { header: "Descripción",  key: "description",  width: 30 },
    { header: "Monto S/",     key: "amount",       width: 12 },
    { header: "Método",       key: "method",       width: 14 },
    { header: "Categoría",    key: "category",     width: 18 },
    { header: "Notas",        key: "notes",        width: 24 },
  ];
  ws1.getRow(1).eachCell(c => {
    c.fill = headerFill; c.font = headerFont;
    c.alignment = { vertical: "middle", horizontal: "center" }; c.border = border;
  });
  ws1.getRow(1).height = 22;
  ws1.views = [{ state: "frozen", ySplit: 1 }];

  const evenFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F4FF" } };
  const oddFill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };

  transactions.forEach((t, i) => {
    const row = ws1.addRow({
      num: i + 1, uid: t.uid || "",
      fecha: formatDate(t.date),
      recipient: t.recipient || "—",
      description: t.description || "—",
      amount: parseFloat(t.amount || 0),
      method: t.method || "—",
      category: t.category || "—",
      notes: t.notes || "—",
    });
    row.height = 18;
    const fill = i % 2 === 0 ? evenFill : oddFill;
    row.eachCell(c => { c.fill = fill; c.border = border; c.alignment = { vertical: "middle" }; });
    const ac = row.getCell("amount");
    ac.numFmt = "#,##0.00"; ac.alignment = { horizontal: "right", vertical: "middle" };
  });

  const tr = ws1.addRow({
    num: "", uid: "", fecha: "", recipient: "", description: "TOTAL",
    amount: total, method: "", category: "", notes: "",
  });
  tr.height = 20;
  tr.eachCell(c => {
    c.font = { bold: true };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    c.border = border; c.alignment = { vertical: "middle" };
  });
  tr.getCell("description").alignment = { horizontal: "right", vertical: "middle" };
  tr.getCell("amount").numFmt = "#,##0.00";
  tr.getCell("amount").alignment = { horizontal: "right", vertical: "middle" };

  // ── SHEET 2: Resumen por Categoría ─────────────────────────────────────
  const ws2 = wb.addWorksheet("Resumen por Categoría");
  ws2.columns = [
    { key: "cat", width: 20 }, { key: "cnt", width: 10 },
    { key: "tot", width: 14 }, { key: "pct", width: 12 },
    { key: "bar", width: 32 },
  ];

  ws2.mergeCells("A1:E1");
  const titleCell = ws2.getCell("A1");
  titleCell.value = "RESUMEN POR CATEGORÍA";
  titleCell.font = { bold: true, size: 14, color: { argb: "FF1A56DB" } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
  ws2.getRow(1).height = 30;

  ws2.getRow(2).values = ["Categoría", "N° Pagos", "Total S/", "Porcentaje", "Visual (%)"];
  ws2.getRow(2).eachCell(c => {
    c.fill = headerFill; c.font = headerFont;
    c.alignment = { vertical: "middle", horizontal: "center" }; c.border = border;
  });
  ws2.getRow(2).height = 22;

  const byCategory = {};
  FIXED_CATEGORIES.forEach(c => { byCategory[c] = { count: 0, total: 0 }; });
  transactions.forEach(t => {
    const cat = (t.category || "").trim();
    const match = FIXED_CATEGORIES.find(c =>
      c.toLowerCase() === cat.toLowerCase() ||
      c.toLowerCase().replace(/\s/g,"") === cat.toLowerCase().replace(/\s/g,"")
    );
    const key = match || "Otros Gastos";
    byCategory[key].count++;
    byCategory[key].total += parseFloat(t.amount || 0);
  });

  const catColors = [
    "FF3B82F6","FF10B981","FFF59E0B","FF8B5CF6",
    "FFEF4444","FF06B6D4","FFEC4899","FF6B7280",
  ];
  const sorted = FIXED_CATEGORIES.slice().sort((a,b) => byCategory[b].total - byCategory[a].total);

  sorted.forEach((cat, i) => {
    const d = byCategory[cat];
    const pct = total > 0 ? (d.total / total) * 100 : 0;
    const filled = Math.round(pct / 5);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    const row = ws2.addRow([cat, d.count, d.total, pct / 100, bar]);
    row.height = 20;
    row.getCell(3).numFmt = "#,##0.00";
    row.getCell(4).numFmt = "0.0%";
    row.getCell(5).font = { color: { argb: catColors[i % catColors.length] }, name: "Courier New", size: 10 };
    row.eachCell({ includeEmpty: true }, (c, col) => {
      if (col <= 5) { c.border = border; c.alignment = { vertical: "middle" }; }
    });
    row.getCell(1).alignment = { vertical: "middle", horizontal: "left" };
    row.getCell(2).alignment = { vertical: "middle", horizontal: "center" };
    row.getCell(3).alignment = { vertical: "middle", horizontal: "right" };
    row.getCell(4).alignment = { vertical: "middle", horizontal: "center" };
  });

  const tr2 = ws2.addRow(["TOTAL", transactions.length, total, 1, ""]);
  tr2.height = 22;
  tr2.getCell(3).numFmt = "#,##0.00";
  tr2.getCell(4).numFmt = "0.0%";
  for (let c = 1; c <= 5; c++) {
    const cell = tr2.getCell(c);
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    cell.border = border;
    cell.alignment = { vertical: "middle" };
  }
  tr2.getCell(1).alignment = { horizontal: "left",  vertical: "middle" };
  tr2.getCell(3).alignment = { horizontal: "right", vertical: "middle" };

  // ── SHEET 3: Comprobantes ───────────────────────────────────────────────
  const ws3 = wb.addWorksheet("Comprobantes");
  ws3.columns = [
    { key: "num",  width: 6  },
    { key: "info", width: 32 },
    { key: "img",  width: 42 },
  ];

  ws3.mergeCells("A1:C1");
  const t3 = ws3.getCell("A1");
  t3.value = "COMPROBANTES";
  t3.font = { bold: true, size: 14, color: { argb: "FF1A56DB" } };
  t3.alignment = { horizontal: "center", vertical: "middle" };
  t3.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
  ws3.getRow(1).height = 30;

  ws3.getRow(2).values = ["#", "Información", "Comprobante"];
  ws3.getRow(2).eachCell(c => {
    c.fill = headerFill; c.font = headerFont;
    c.alignment = { vertical: "middle", horizontal: "center" }; c.border = border;
  });
  ws3.getRow(2).height = 22;

  let imgRowIdx = 3;
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    const info = [
      `#${i+1}  |  ${formatDate(t.date)}`,
      `Destinatario: ${t.recipient || "—"}`,
      `Monto: S/ ${parseFloat(t.amount||0).toFixed(2)}`,
      `Método: ${t.method || "—"}`,
      `Categoría: ${t.category || "—"}`,
      `Descripción: ${t.description || "—"}`,
    ].join("\n");

    const row = ws3.getRow(imgRowIdx);
    row.getCell(1).value = i + 1;
    row.getCell(1).alignment = { horizontal: "center", vertical: "top" };
    row.getCell(1).border = border;
    row.getCell(2).value = info;
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row.getCell(2).border = border;
    row.getCell(3).border = border;

    if (t.image_url) {
      const buf = await fetchImageBuffer(t.image_url);
      if (buf) {
        const ext = getExtFromUrl(t.image_url);
          const { w: imgW, h: imgH } = getImageSize(buf);
          const maxW = 280;
          const scale = maxW / Math.max(imgW, 1);
          const dispW = maxW;
          const dispH = Math.round(imgH * scale);
          // Adjust row height to fit image (Excel row height ≈ px * 0.755)
          row.height = Math.max(100, Math.round(dispH * 0.755));
          const imgId = wb.addImage({ buffer: buf, extension: imgType });
          ws3.addImage(imgId, {
            tl: { col: 2, row: imgRowIdx - 1 },
            ext: { width: dispW, height: dispH },
            editAs: "oneCell",
          });
        } catch (_) {
          row.getCell(3).value = "(imagen no disponible)";
          row.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
        }
      } else {
        row.getCell(3).value = "(sin imagen)";
        row.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
      }
    } else {
      row.getCell(3).value = "(sin imagen)";
      row.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
    }
    imgRowIdx++;
  }

  // ── GUARDAR ─────────────────────────────────────────────────────────────
  const first = transactions[0] ? transactions[0].date : "inicio";
  const last  = transactions[transactions.length - 1]
    ? transactions[transactions.length - 1].date : "fin";
  const fp = path.join("/tmp", `FinTrack_${first}_al_${last}.xlsx`);
  await wb.xlsx.writeFile(fp);
  return fp;
}

module.exports = { generateExcel };
