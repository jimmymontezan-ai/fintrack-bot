const XLSX = require("xlsx");
const path = require("path");

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function generateExcel(transactions) {
  const wb = XLSX.utils.book_new();
  const total = transactions.reduce(function(s, t) { return s + parseFloat(t.amount || 0); }, 0);

  const rows = transactions.map(function(t, i) {
    return { "#": i + 1, "Codigo": t.uid, "Fecha": formatDate(t.date), "Destinatario": t.recipient || "—", "Descripcion": t.description || "—", "Monto S/": parseFloat(t.amount || 0).toFixed(2), "Metodo": t.method || "—", "Categoria": t.category || "—", "Notas": t.notes || "—" };
  });
  rows.push({ "#": "", "Codigo": "", "Fecha": "", "Destinatario": "", "Descripcion": "TOTAL", "Monto S/": total.toFixed(2), "Metodo": "", "Categoria": "", "Notas": "" });

  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Transacciones");

  const byCategory = {};
  transactions.forEach(function(t) {
    var c = t.category || "Otro";
    if (!byCategory[c]) byCategory[c] = { count: 0, total: 0 };
    byCategory[c].count++;
    byCategory[c].total += parseFloat(t.amount || 0);
  });

  const resumenRows = Object.keys(byCategory).sort(function(a, b) {
    return byCategory[b].total - byCategory[a].total;
  }).map(function(cat) {
    return { "Categoria": cat, "N Pagos": byCategory[cat].count, "Total S/": byCategory[cat].total.toFixed(2), "Porcentaje": ((byCategory[cat].total / total) * 100).toFixed(1) + "%" };
  });
  resumenRows.push({ "Categoria": "TOTAL", "N Pagos": transactions.length, "Total S/": total.toFixed(2), "Porcentaje": "100%" });

  const ws2 = XLSX.utils.json_to_sheet(resumenRows);
  XLSX.utils.book_append_sheet(wb, ws2, "Resumen");

  const desde = formatDate(transactions[0] ? transactions[0].date : "").replace(/\//g, "-");
  const hasta = formatDate(transactions[transactions.length - 1] ? transactions[transactions.length - 1].date : "").replace(/\//g, "-");
  const fp = path.join("/tmp", "FinTrack_" + desde + "_al_" + hasta + ".xlsx");
  XLSX.writeFile(wb, fp);
  return fp;
}

module.exports = { generateExcel };
