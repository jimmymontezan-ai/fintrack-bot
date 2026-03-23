const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
function formatDate(iso) { if (!iso) return "—"; return new Date(iso+"T00:00:00").toLocaleDateString("es-PE",{day:"2-digit",month:"2-digit",year:"numeric"}); }
function generateExcel(transactions) {
  const wb = XLSX.utils.book_new();
  const rows = transactions.map((t,i) => ({"#":i+1,"Código":t.uid,"Fecha":formatDate(t.date),"Destinatario":t.recipient||"—","Descripción":t.description||"—","Monto S/":parseFloat(t.amount||0).toFixed(2),"Método":t.method||"—","Categoría":t.category||"—","Notas":t.notes||"—"}));
  rows.push({"#":"","Código":"","Fecha":"","Destinatario":"","Descripción":"TOTAL","Monto S/":transactions.reduce((s,t)=>s+parseFloat(t.amount||0),0).toFixed(2),"Método":"","Categoría":"","Notas":""});
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"]=[{wch:4},{wch:22},{wch:12},{wch:26},{wch:26},{wch:12},{wch:14},{wch:16},{wch:28}];
  XLSX.utils.book_append_sheet(wb,"Transacciones",ws);
  const byCategory = {};
  transactions.forEach(t => { const c=t.category||"Otro"; if(!byCategory[c]) byCategory[c]={count:0,total:0}; byCategory[c].count++; byCategory[c].total+=parseFloat(t.amount||0); });
  const total = transactions.reduce((s,t)=>s+parseFloat(t.amount||0),0);
  const resumen = Object.entries(byCategory).sort((a,b)=>b[1].total-a[1].total).map(([cat,{count,total:v}])=({"Categoría":cat,"N° Pagos":count,"Total S/":v.toFixed(2),"% Gasto":((v/total)*100).toFixed(1)+"%"}));
  resumen.push({"Categoría":"TOTAL","N° Pagos":transactions.length,"Total S/":total.toFixed(2),"% Gasto":"100%"});
  const ws2 = XLSX.utils.json_to_sheet(resumen);
  ws2["!cols"]=[{wch:20},{wch:10},{wch:12},{wch:12}];
  XLSX.utils.book_append_sheet(wb,"Resumen",ws2);
  const desde = formatDate(transactions[0]?.date).replace(/\//g,"-");
  const hasta = formatDate(transactions[transactions.length-1]?.date).replace(/\//g,"-");
  const fp = path.join("/tmp",`FinTrack_${desde}_al_${hasta}.xlsx`);
  XLSX.writeFile(wb,fp);
  return fp;
}
module.exports = { generateExcel };
