#!/usr/bin/env node
// 轻量账本工具：解析 Beancount 风格 .bean 文件，做校验与报表（支持多币种）。
// 用法：
//   node tools/ledger.mjs check            # 校验：每笔交易按币种配平、账户是否已 open
//   node tools/ledger.mjs report [YYYY-MM] # 收支报表（省略月份=全部）
//   node tools/ledger.mjs balance          # 各账户余额（按币种）
//   node tools/ledger.mjs list [YYYY-MM]   # 列出交易明细

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(ROOT, "main.bean");

function listBeanFiles() {
  const files = [MAIN];
  for (const dir of ["transactions"]) {
    const p = path.join(ROOT, dir);
    if (fs.existsSync(p)) for (const f of fs.readdirSync(p).sort()) if (f.endsWith(".bean")) files.push(path.join(p, f));
  }
  const acc = path.join(ROOT, "accounts.bean");
  if (fs.existsSync(acc)) files.push(acc);
  return files;
}

function parse(files) {
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

const money = (n) => (n < 0 ? "-" : "") + Math.abs(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 把每笔交易的 posting 补齐（省略金额的那条用反数），返回 [{account,currency,amount,date,payee,narration,flag}]
function postings(parsed) {
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
      out.push({ ...p, amount: amt, date: t.date, payee: t.payee, narration: t.narration, flag: t.flag });
    }
  }
  return out;
}

function check(parsed) {
  const { opens, txns, errors } = parsed;
  const problems = [...errors];

  for (const t of txns) {
    if (t.postings.length < 2) { problems.push(`${t.where}: 交易「${t.narration}」posting 少于 2 条`); continue; }
    const missing = t.postings.filter((p) => p.amount === null);
    if (missing.length > 1) { problems.push(`${t.where}: 交易「${t.narration}」有 ${missing.length} 条 posting 没写金额，最多省略 1 条`); continue; }
    for (const p of t.postings) {
      const allowed = opens.get(p.account);
      if (!allowed) { problems.push(`${p.where}: 账户未 open: ${p.account}`); continue; }
      if (!allowed.has(p.currency)) problems.push(`${p.where}: 账户 ${p.account} 未声明币种 ${p.currency}（open 行里加上）`);
    }
    if (missing.length) continue; // 省略的那条自动平衡
    const byCur = new Map();
    for (const p of t.postings) byCur.set(p.currency, (byCur.get(p.currency) || 0) + p.amount);
    for (const [c, s] of byCur) if (Math.abs(s) > 0.005) problems.push(`${t.where}: 交易「${t.narration}」未配平，${c} 差额 ${money(s)}`);
  }

  if (problems.length) {
    console.error(`✗ 校验未通过，${problems.length} 个问题：`);
    for (const p of problems) console.error("  - " + p);
    process.exitCode = 1;
    return false;
  }
  console.log(`✓ 校验通过：${txns.length} 笔交易，${opens.size} 个账户，全部配平`);
  return true;
}

function report(parsed, month) {
  const rows = postings(parsed).filter((p) => !month || p.date.startsWith(month));
  const inc = new Map(); // currency -> Map(account -> amount)
  const exp = new Map();
  const bump = (m, c, a, v) => {
    if (!m.has(c)) m.set(c, new Map());
    m.get(c).set(a, (m.get(c).get(a) || 0) + v);
  };
  for (const p of rows) {
    if (p.account.startsWith("Income:")) bump(inc, p.currency, p.account, p.amount);
    if (p.account.startsWith("Expenses:")) bump(exp, p.currency, p.account, p.amount);
  }
  const currs = [...new Set([...inc.keys(), ...exp.keys()])].sort();
  console.log(`\n📊 ${month ? month + " " : "全部"}收支`);
  if (!currs.length) { console.log("  （本月没有收入/支出记录）\n"); return; }
  for (const c of currs) {
    let i = 0, e = 0;
    console.log(`\n— ${c} —`);
    console.log("收入：");
    for (const [a, v] of [...(inc.get(c) || new Map())].sort((x, y) => x[1] - y[1])) { console.log(`  ${a.padEnd(24)} ${money(-v)}`); i += v; }
    console.log(`  合计 ${money(-i)}`);
    console.log("支出：");
    for (const [a, v] of [...(exp.get(c) || new Map())].sort((x, y) => y[1] - x[1])) { console.log(`  ${a.padEnd(24)} ${money(v)}`); e += v; }
    console.log(`  合计 ${money(e)}`);
    console.log(`结余：${money(-i - e)}`);
  }
  console.log();
}

function balance(parsed) {
  const rows = postings(parsed);
  const m = new Map(); // key account|currency
  for (const p of rows) {
    const k = `${p.account}|${p.currency}`;
    m.set(k, (m.get(k) || 0) + p.amount);
  }
  console.log("\n账户余额：");
  for (const [k, v] of [...m].sort((x, y) => x[0].localeCompare(y[0]))) {
    const [a, c] = k.split("|");
    console.log(`  ${a.padEnd(28)} ${money(v).padStart(12)} ${c}`);
  }
  console.log();
}

function list(parsed, month) {
  const rows = parsed.txns.filter((t) => !month || t.date.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date));
  console.log(`\n${month || "全部"} 交易（${rows.length} 笔）`);
  for (const t of rows) {
    const ps = t.postings.map((p) => `${p.account} ${p.amount === null ? "（自动）" : money(p.amount) + " " + p.currency}`).join(" | ");
    console.log(`\n${t.date} ${t.flag} ${t.payee ? t.payee + " / " : ""}${t.narration}`);
    console.log(`  ${ps}`);
  }
  console.log();
}

const cmd = process.argv[2] || "check";
const parsed = parse(listBeanFiles());
if (parsed.errors.length) for (const e of parsed.errors) console.error("解析错误 " + e);

if (cmd === "check") check(parsed);
else if (cmd === "report") { if (check(parsed)) report(parsed, process.argv[3]); }
else if (cmd === "balance") { if (check(parsed)) balance(parsed); }
else if (cmd === "list") { if (check(parsed)) list(parsed, process.argv[3]); }
else { console.error("用法: node tools/ledger.mjs [check|report [YYYY-MM]|balance|list [YYYY-MM]]"); process.exitCode = 2; }
