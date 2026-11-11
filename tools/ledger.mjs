#!/usr/bin/env node
// 轻量账本工具：解析 Beancount 风格 .bean 文件，做校验与报表（支持多币种）。
// 用法：
//   node tools/ledger.mjs check            # 校验：每笔交易按币种配平、账户是否已 open
//   node tools/ledger.mjs report [YYYY-MM] # 收支报表（省略月份=全部）
//   node tools/ledger.mjs balance          # 各账户余额（按币种）
//   node tools/ledger.mjs list [YYYY-MM]   # 列出交易明细

import { listBeanFiles, parse, money, postings } from "./ledger-core.mjs";

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
