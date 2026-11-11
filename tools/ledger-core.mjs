// 账本解析核心：被 CLI（tools/ledger.mjs）与站点生成器（tools/build-site.mjs）共用。
// 只依赖 Node 内置模块，保持零依赖。

import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const MAIN = path.join(ROOT, "main.bean");

export function listBeanFiles() {
  const files = [MAIN];
  for (const dir of ["transactions"]) {
    const p = path.join(ROOT, dir);
    if (fs.existsSync(p)) for (const f of fs.readdirSync(p).sort()) if (f.endsWith(".bean")) files.push(path.join(p, f));
  }
  const acc = path.join(ROOT, "accounts.bean");
  if (fs.existsSync(acc)) files.push(acc);
  return files;
}

export function parse(files) {
  const opens = new Map(); // account -> Set(currency)
  const txns = [];
  const errors = [];
  let cur = null;
  const pushCur = () => { if (cur) txns.push(cur); cur = null; };

  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((raw, i) => {
      const where = `${path.relative(ROOT, file)}:${i + 1}`;
      const line = raw.replace(/;.*$/, "").trimEnd();
      if (!line.trim()) return;

      const openM = line.match(/^(\d{4}-\d{2}-\d{2})\s+open\s+([A-Za-z][\w:.-]*)(?:\s+([A-Z]{3}(?:\s*,\s*[A-Z]{3})*))?/);
      if (openM) {
        pushCur();
        const acct = openM[2];
        const currs = (openM[3] || "CNY").split(/\s*,\s*/);
        if (!opens.has(acct)) opens.set(acct, new Set());
        for (const c of currs) opens.get(acct).add(c);
        return;
      }
      if (/^(option|include|plugin|pushtag|poptag)\b/.test(line.trim())) { pushCur(); return; }

      const txM = line.match(/^(\d{4}-\d{2}-\d{2})\s+([*!])\s*(?:"([^"]*)")?\s*(?:"([^"]*)")?/);
      if (txM) {
        pushCur();
        cur = { date: txM[1], flag: txM[2], payee: txM[3] || "", narration: txM[4] || txM[3] || "", postings: [], where };
        return;
      }
      if (cur && /^\s{1,}\S/.test(raw)) {
        const pm = line.trim().match(/^([A-Za-z][\w:.-]*)(?:\s+(-?[\d,]+(?:\.\d+)?)\s*([A-Z]{3}))?/);
        if (!pm) { errors.push(`${where}: 无法解析的 posting: ${raw.trim()}`); return; }
        cur.postings.push({
          account: pm[1],
          amount: pm[2] === undefined ? null : Number(pm[2].replace(/,/g, "")),
          currency: pm[3] || "CNY",
          where,
        });
        return;
      }
      errors.push(`${where}: 无法解析的行: ${raw.trim()}`);
    });
  }
  pushCur();
  return { opens, txns, errors };
}

export const money = (n) => (n < 0 ? "-" : "") + Math.abs(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 把每笔交易的 posting 补齐（省略金额的那条用反数），返回 [{account,currency,amount,date,payee,narration,flag}]
export function postings(parsed) {
  const out = [];
  for (const t of parsed.txns) {
    const byCur = new Map();
    for (const p of t.postings.filter((p) => p.amount !== null)) {
      byCur.set(p.currency, (byCur.get(p.currency) || 0) + p.amount);
    }
    const missing = t.postings.filter((p) => p.amount === null);
    for (const p of t.postings) {
      let amt = p.amount;
      if (amt === null) {
        const currs = [...byCur.keys()];
        const c = p.currency && byCur.has(p.currency) ? p.currency : currs[0] || "CNY";
        amt = -(byCur.get(c) || 0);
      }
      out.push({ ...p, amount: amt, date: t.date, payee: t.payee, narration: t.narration, flag: t.flag, txn: t });
    }
  }
  return out;
}
