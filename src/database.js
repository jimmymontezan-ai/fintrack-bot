const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
function generateUID() {
  return `TXN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
}
async function saveTransaction(data) {
  const uid = generateUID();
  const { data: row, error } = await supabase.from("transactions").insert([{ ...data, uid }]).select().single();
  if (error) throw error;
  return row;
}
async function getTransactionsSince(days = 15) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data, error } = await supabase.from("transactions").select("*").gte("date", since.toISOString().slice(0,10)).order("date", { ascending: true });
  if (error) throw error;
  return data || [];
}
async function getSummary(days = 15) {
  const transactions = await getTransactionsSince(days);
  const total = transactions.reduce((s,t) => s + parseFloat(t.amount||0), 0);
  const byCategory = {};
  transactions.forEach(t => { byCategory[t.category] = (byCategory[t.category]||0) + parseFloat(t.amount||0); });
  return { total, count: transactions.length, byCategory };
}
module.exports = { saveTransaction, getTransactionsSince, getSummary };
