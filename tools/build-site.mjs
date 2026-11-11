#!/usr/bin/env node
// 静态站点生成器：把账本（beancount）与两份台账（subscriptions.md / consumables.md）
// 渲染成 Wallos 风格的静态页面，输出到 site/，供 GitHub Pages 发布。
//
// 用法：node tools/build-site.mjs
// 环境变量：SITE_TODAY=YYYY-MM-DD 可覆盖「今天」（默认 Asia/Shanghai 当天），
//           便于本地复现某天的页面。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, listBeanFiles, parse, postings } from "./ledger-core.mjs";

const SITE_DIR = path.join(ROOT, "site");
const ASSET_DIR = path.join(ROOT, "tools", "site");
const REPO_URL = "https://github.com/TangMisaka23001/book-keeping";
const TIME_ZONE = "Asia/Shanghai";

const DAY_MS = 86400000;
const MONTH_NAMES = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];

const CURRENCY = {
  CNY: { symbol: "¥", label: "人民币" },
  USD: { symbol: "$", label: "美元" },
  HKD: { symbol: "HK$", label: "港币" },
};
const CURRENCY_ORDER = ["CNY", "USD", "HKD"];

const CYCLE = {
  年付: { months: 12, label: "年付", per: "/年" },
  半年付: { months: 6, label: "半年付", per: "/半年" },
  季付: { months: 3, label: "季付", per: "/季" },
  月付: { months: 1, label: "月付", per: "/月" },
};

const ACCOUNT_LABELS = {
  "Liabilities:CreditCard": "信用卡",
  "Assets:Alipay": "支付宝",
  "Assets:WeChat": "微信零钱",
  "Assets:Bank:CMB": "招商银行",
  "Assets:Bank:ICBC": "工商银行",
  "Assets:PhoneBalance:Guangdian": "广电话费余额",
  "Assets:PhoneBalance:Mobile": "移动话费余额",
  "Assets:PhoneBalance:HK": "香港号话费余额",
};

// ---------- 小工具 ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const pad2 = (n) => String(n).padStart(2, "0");
const numFmt = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtMoney(amount, currency) {
  const meta = CURRENCY[currency];
  return `${meta ? meta.symbol : currency + " "}${numFmt.format(amount)}`;
}

function fmtNumber(amount) {
  return numFmt.format(amount);
}

function isoDate(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / DAY_MS);
}

function relLabel(days) {
  if (days < -1) return `${Math.abs(days)} 天前`;
  if (days === -1) return "昨天";
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  return `${days} 天后`;
}

function orderCurrencies(map) {
  const keys = Object.keys(map).filter((k) => map[k] !== 0);
  const ordered = CURRENCY_ORDER.filter((k) => keys.includes(k));
  return ordered.concat(keys.filter((k) => !CURRENCY_ORDER.includes(k)).sort()).map((currency) => ({ currency, amount: map[currency] }));
}

function sumByCurrency(items, field) {
  const out = {};
  for (const it of items) out[it.currency] = (out[it.currency] || 0) + it[field];
  return out;
}

function totalsLine(map) {
  const entries = orderCurrencies(map);
  if (!entries.length) return "—";
  return entries.map((e) => fmtMoney(e.amount, e.currency)).join(" · ");
}

// ---------- Markdown 台账 ----------

function tableFrom(lines) {
  const raw = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
  if (raw.length < 2) return null;
  const header = raw[0];
  const body = raw.slice(2).filter((cells) => !cells.every((c) => c === "" || c === "—" || c === "-"));
  return { header, rows: body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]))) };
}

function parseMarkdownSections(file) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const sections = [];
  let cur = { title: "", lines: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      sections.push(cur);
      cur = { title: m[1], lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  sections.push(cur);
  return sections
    .map((s) => ({ title: s.title, table: tableFrom(s.lines) }))
    .filter((s) => s.title && s.table);
}

function findSection(sections, prefix, file) {
  const hit = sections.find((s) => s.title.startsWith(prefix));
  if (!hit) throw new Error(`${file} 中找不到「## ${prefix}」小节`);
  return hit.table;
}

// ---------- 订阅数据 ----------

function parseAmount(raw) {
  const s = raw.replace(/\s+/g, "");
  let m = s.match(/^(HK\$|\$|¥)([\d.,]+)$/);
  if (m) {
    const currency = m[1] === "HK$" ? "HKD" : m[1] === "$" ? "USD" : "CNY";
    return { amount: Number(m[2].replace(/,/g, "")), currency };
  }
  m = s.match(/^([\d.,]+)([A-Z]{3})$/);
  if (m) return { amount: Number(m[1].replace(/,/g, "")), currency: m[2] };
  throw new Error(`无法解析金额「${raw}」（支持 ¥168 / $10 / 36 HKD 等写法）`);
}

function parseBilling(raw) {
  const s = raw.replace(/\s+/g, "");
  let m = s.match(/^每年(\d{1,2})-(\d{2})$/);
  if (m) return { kind: "yearly", month: Number(m[1]), day: Number(m[2]), label: `每年 ${pad2(m[1])}-${m[2]}` };
  m = s.match(/^每月(\d{1,2})号?$/);
  if (m) return { kind: "monthly", day: Number(m[1]), label: `每月 ${m[1]} 号` };
  return null;
}

function nextChargeDate(billing, todayISO) {
  if (!billing) return null;
  const [todayY, todayM, todayD] = todayISO.split("-").map(Number);

  if (billing.kind === "yearly") {
    const thisYear = isoDate(todayY, billing.month, Math.min(billing.day, daysInMonth(todayY, billing.month)));
    if (todayISO <= thisYear) return thisYear;
    const nextYear = todayY + 1;
    return isoDate(nextYear, billing.month, Math.min(billing.day, daysInMonth(nextYear, billing.month)));
  }

  let y = todayY;
  let m = todayM;
  let candidate = isoDate(y, m, Math.min(billing.day, daysInMonth(y, m)));
  if (todayISO > candidate) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    candidate = isoDate(y, m, Math.min(billing.day, daysInMonth(y, m)));
  }
  return candidate;
}

const MONOGRAMS = [
  [/racknerd/i, "RN"],
  [/spaceship|misakatang/i, "SP"],
  [/香港|5709/i, "HK"],
  [/opencode/i, "OC"],
  [/88vip|淘宝/i, "88"],
  [/广电/i, "广电"],
  [/移动/i, "移动"],
  [/刀片|剃须/i, "刀"],
];

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function monogram(name) {
  for (const [re, label] of MONOGRAMS) if (re.test(name)) return label;
  const latin = name.match(/[A-Za-z]/g);
  if (latin) return latin.slice(0, 2).join("").toUpperCase();
  return name.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").slice(0, 1) || "?";
}

function toneClass(name) {
  return `tone-${(hashString(name) % 6) + 1}`;
}

function paymentKind(payment) {
  if (/信用卡|card/i.test(payment)) return "card";
  if (/支付宝|alipay/i.test(payment)) return "alipay";
  if (/话费|余额/.test(payment)) return "phone";
  return "";
}

function loadSubscriptions(todayISO) {
  const file = "subscriptions.md";
  const sections = parseMarkdownSections(file);
  const activeTable = findSection(sections, "在用", file);
  const cancelledTable = sections.find((s) => s.title.startsWith("已取消"))?.table ?? { rows: [] };

  const toRow = (r) => {
    const name = r["订阅"];
    const { amount, currency } = parseAmount(r["金额"]);
    const cycle = CYCLE[r["周期"]];
    if (!cycle) throw new Error(`${file} 中「${name}」的周期「${r["周期"]}」无法识别（支持 ${Object.keys(CYCLE).join(" / ")}）`);
    const billing = parseBilling(r["扣费日"]);
    if (!billing) console.warn(`! 无法解析「${name}」的扣费日「${r["扣费日"]}」，下次扣费将显示为 —`);
    const nextDate = nextChargeDate(billing, todayISO);
    const monthly = amount / cycle.months;
    return {
      name,
      amount,
      currency,
      cycle,
      billing,
      nextDate,
      monthly,
      yearly: monthly * 12,
      payment: r["支付方式"],
      paymentKind: paymentKind(r["支付方式"]),
      reminder: r["提醒"],
      status: r["状态"],
      active: String(r["状态"]).includes("在用"),
      tone: toneClass(name),
      monogram: monogram(name),
    };
  };

  return {
    active: activeTable.rows.map(toRow),
    cancelled: cancelledTable.rows.map((r) => ({
      name: r["订阅"],
      cancelledAt: r["取消日期"],
      note: r["备注"],
    })),
  };
}

// ---------- 耗材数据 ----------

function loadConsumables(todayISO) {
  const file = "consumables.md";
  const sections = parseMarkdownSections(file);
  const inUseTable = findSection(sections, "在用", file);
  const usedTable = sections.find((s) => s.title.startsWith("已用完"))?.table ?? { rows: [] };

  const inUse = inUseTable.rows.map((r) => {
    const name = r["耗材"];
    const { amount, currency } = parseAmount(r["价格"]);
    const date = r["购买日"];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${file} 中「${name}」的购买日「${date}」不是 YYYY-MM-DD`);
    const days = Math.max(0, daysBetween(date, todayISO));
    return {
      name,
      amount,
      currency,
      date,
      days,
      dailyCost: days > 0 ? amount / days : amount,
      channel: r["渠道"],
      note: r["备注"],
      tone: toneClass(name),
      monogram: monogram(name),
    };
  });

  const used = usedTable.rows.map((r) => ({
    name: r["耗材"],
    lastBought: r["上次购买日"],
    replacedAt: r["换新日"],
    days: r["用了多少天"],
    dailyCost: r["日均成本"],
    note: r["备注"],
  }));

  return { inUse, used };
}

// ---------- 账本支出记录 ----------

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[\s·•/\\,，。、（）()\-—_：:]/g, "");

function matchByName(items, txn) {
  const payee = norm(txn.payee);
  const narration = norm(txn.narration);
  for (const it of items) {
    const key = norm(it.name);
    if (!key) continue;
    if (payee && (payee.includes(key) || (key.includes(payee) && payee.length >= 2))) return it;
    if (narration && narration.includes(key)) return it;
  }
  return null;
}

function accountLabel(account) {
  if (ACCOUNT_LABELS[account]) return ACCOUNT_LABELS[account];
  return account.split(":").pop();
}

function categoryOf(account) {
  if (account.startsWith("Expenses:Subscription")) return { label: "订阅", cls: "" };
  if (account.startsWith("Expenses:Phone")) return { label: "通信", cls: "phone" };
  if (account.startsWith("Expenses:Consumables")) return { label: "耗材", cls: "consumable" };
  return { label: account.split(":").pop(), cls: "" };
}

function loadExpenseRecords(subs, consumables) {
  const parsed = parse(listBeanFiles());
  if (parsed.errors.length) {
    for (const e of parsed.errors) console.error("解析错误 " + e);
    process.exitCode = 1;
  }

  // 按交易分组（postings() 会补全省略金额的 posting），取每条交易里的支出与付款账户。
  const groups = new Map();
  for (const p of postings(parsed)) {
    if (!groups.has(p.txn)) groups.set(p.txn, []);
    groups.get(p.txn).push(p);
  }

  const records = [];
  for (const [txn, rows] of groups) {
    const expenses = rows.filter((r) => r.account.startsWith("Expenses:"));
    if (!expenses.length) continue;
    const payment = rows.find((r) => /^(Assets|Liabilities):/.test(r.account));
    const sub = matchByName(subs, txn);
    const con = matchByName(consumables, txn);
    for (const e of expenses) {
      records.push({
        date: txn.date,
        payee: txn.payee,
        narration: txn.narration,
        account: e.account,
        amount: e.amount,
        currency: e.currency,
        paymentAccount: payment ? payment.account : "",
        payment: payment ? accountLabel(payment.account) : "—",
        subscription: sub ? sub.name : null,
        consumable: con ? con.name : null,
        category: categoryOf(e.account),
      });
    }
  }

  records.sort((a, b) => (a.date === b.date ? b.amount - a.amount : b.date.localeCompare(a.date)));
  return records;
}

// ---------- 页面片段 ----------

function statCard({ label, value, sub = "", accent = false }) {
  return `        <div class="stat-card">
          <div class="stat-label">${label}</div>
          <div class="stat-value${accent ? " accent" : ""}">${value}</div>
          ${sub ? `<div class="stat-sub">${sub}</div>` : ""}
        </div>`;
}

function emptyState(title, desc) {
  return `      <div class="panel">
        <div class="empty">
          <div class="empty-title">${esc(title)}</div>
          <div>${esc(desc)}</div>
        </div>
      </div>`;
}

function logoHtml(item) {
  return `<span class="logo ${item.tone}">${esc(item.monogram)}</span>`;
}

function upcomingCard(sub, todayISO) {
  const days = sub.nextDate ? daysBetween(todayISO, sub.nextDate) : null;
  return `        <article class="up-card">
          <div class="up-top">
            ${logoHtml(sub)}
            <div class="up-name">${esc(sub.name)}</div>
          </div>
          <div class="up-body">
            <div class="up-price">${fmtMoney(sub.amount, sub.currency)}<span class="per">${esc(sub.cycle.per)}</span></div>
            <div class="up-when">${sub.nextDate ? esc(sub.nextDate) : "—"}${days !== null ? ` · <span data-countdown="${sub.nextDate}">${relLabel(days)}</span>` : ""}</div>
          </div>
        </article>`;
}

function subscriptionRow(sub, todayISO) {
  const days = sub.nextDate ? daysBetween(todayISO, sub.nextDate) : null;
  const meta = `${sub.cycle.label} · ${sub.nextDate ? sub.nextDate : "扣费日待定"} · ${sub.payment}`;
  return `        <div class="sub-row">
          ${logoHtml(sub)}
          <div class="sub-name">
            <div class="sub-title">${esc(sub.name)}</div>
            <div class="sub-meta">${esc(meta)}</div>
          </div>
          <div class="cell cycle">${esc(sub.cycle.label)}</div>
          <div class="cell next">${sub.nextDate ? esc(sub.nextDate) : "—"}${days !== null ? ` <span class="rel">（${relLabel(days)}）</span>` : ""}</div>
          <div class="price">${fmtMoney(sub.amount, sub.currency)}<span class="per">${esc(sub.cycle.per)}</span></div>
          <div class="cell pm"><span class="pill ${sub.paymentKind}"><span class="dot"></span>${esc(sub.payment)}</span></div>
        </div>`;
}

function recordRow(rec) {
  const title = rec.subscription || rec.consumable || rec.payee || "未命名支出";
  return `          <tr>
            <td class="date">${esc(rec.date)}</td>
            <td><span class="tag${rec.category.cls ? " " + rec.category.cls : ""}">${esc(rec.category.label)}</span></td>
            <td>
              <div class="t-title">${esc(title)}</div>
              <div class="t-sub">${esc(rec.narration)}</div>
            </td>
            <td class="num">${fmtMoney(rec.amount, rec.currency)}</td>
            <td class="cell muted">${esc(rec.payment)}</td>
          </tr>`;
}

function recordsTable(records, subject = "订阅 / 摘要") {
  if (!records.length) return emptyState("还没有支出记录", "在账本里记一笔，下次构建时就会出现在这里。");
  return `      <div class="panel table-wrap">
        <table>
          <thead>
            <tr><th>日期</th><th>类别</th><th>${subject}</th><th style="text-align:right">金额</th><th>支付账户</th></tr>
          </thead>
          <tbody>
${records.map(recordRow).join("\n")}
          </tbody>
        </table>
      </div>`;
}

// ---------- 布局 ----------

function header(active) {
  const nav = (href, label, isActive) =>
    `<a class="nav-link${isActive ? " is-active" : ""}" href="${href}">${label}</a>`;
  return `    <header class="site-header">
      <div class="contain header-inner">
        <a class="brand" href="index.html">
          <span class="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3H6.5A2.5 2.5 0 0 0 4 10.5v6A2.5 2.5 0 0 0 6.5 19H20V8H6.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.5 12.25h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
          </span>
          <span class="brand-name">个人账本<span>Bookkeeping</span></span>
        </a>
        <nav class="nav">
          ${nav("index.html", "订阅", active === "subscriptions")}
          ${nav("consumables.html", "耗材", active === "consumables")}
          <a class="nav-link" href="${REPO_URL}" target="_blank" rel="noopener">GitHub<span class="ext">↗</span></a>
        </nav>
      </div>
    </header>`;
}

function footer(builtAt, commit) {
  const commitHtml = commit
    ? `<span class="sep">·</span>提交 <a href="${REPO_URL}/commit/${commit}">${commit}</a>`
    : "";
  return `    <footer class="site-footer">
      <div class="contain footer-inner">
        <div>生成于 ${esc(builtAt)}（Asia/Shanghai）${commitHtml}</div>
        <div>由 <a href="${REPO_URL}/actions">GitHub Actions</a> 自动构建<span class="sep">·</span><a href="${REPO_URL}">账本源码</a></div>
      </div>
    </footer>`;
}

function layout({ title, description, active, body, builtAt, commit }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='15' fill='%232563EB'/%3E%3Ctext x='32' y='45' font-size='36' font-family='Arial,Helvetica,sans-serif' font-weight='bold' text-anchor='middle' fill='white'%3E%C2%A5%3C/text%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
${header(active)}
    <main>
      <div class="contain">
${body}
      </div>
    </main>
${footer(builtAt, commit)}
    <script src="app.js" defer></script>
</body>
</html>
`;
}

// ---------- 订阅页 ----------

function subscriptionsPage({ subs, records, todayISO, builtAt, commit }) {
  const active = subs.active;
  const monthly = sumByCurrency(active, "monthly");
  const yearly = sumByCurrency(active, "yearly");
  const monthlyEntries = orderCurrencies(monthly);
  const yearlyEntries = orderCurrencies(yearly);
  const primary = monthlyEntries[0];
  const yearlyPrimary = yearlyEntries[0];

  const sorted = active
    .filter((s) => s.nextDate)
    .slice()
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  const next = sorted[0] || null;
  const nextDays = next ? daysBetween(todayISO, next.nextDate) : null;

  const othersText = (entries) =>
    entries.length > 1 ? entries.slice(1).map((e) => fmtMoney(e.amount, e.currency)).join(" · ") : "只按账本原币种";

  const existingRecords = records.filter((r) => r.account.startsWith("Expenses:Subscription") || r.account.startsWith("Expenses:Phone"));

  const body = `        <div class="page-head">
          <h1>订阅总览</h1>
          <p class="subtitle">${active.length} 个在用订阅，全部来自账本里的真实扣费记录。<b>月度 ${totalsLine(monthly)}</b>，<b>年度 ${totalsLine(yearly)}</b>。</p>
        </div>

        <div class="stat-strip">
${statCard({ label: "在用订阅", value: `${active.length}<span class=\"unit\"> 个</span>`, sub: next ? `下次扣费 ${next.nextDate}` : "暂无扣费日" })}
${statCard({ label: "月度成本", value: primary ? fmtMoney(primary.amount, primary.currency) : "—", accent: true, sub: othersText(monthlyEntries) })}
${statCard({ label: "年度成本", value: yearlyPrimary ? fmtMoney(yearlyPrimary.amount, yearlyPrimary.currency) : "—", sub: othersText(yearlyEntries) })}
${statCard({ label: "下次扣费", value: next ? next.nextDate.slice(5) : "—", accent: true, sub: next ? `${esc(next.name)} · ${fmtMoney(next.amount, next.currency)}<br>${nextDays !== null ? `<span data-countdown="${next.nextDate}">${relLabel(nextDays)}</span>` : ""}` : "无" })}
        </div>

        <section>
          <h2>即将扣费<span class="count">按日期排序</span></h2>
          <div class="upcoming-strip">
${sorted.map((s) => upcomingCard(s, todayISO)).join("\n")}
          </div>
        </section>

        <section>
          <h2>订阅明细<span class="count">${active.length} 项</span></h2>
          <div class="panel">
            <div class="list-head">
              <span></span><span>订阅</span><span class="col-cycle">周期</span><span class="col-next">下次扣费</span><span>金额</span><span class="col-pm">支付方式</span>
            </div>
${active.map((s) => subscriptionRow(s, todayISO)).join("\n")}
          </div>
        </section>

        <section>
          <h2>扣费记录<span class="count">${existingRecords.length} 条</span></h2>
${recordsTable(existingRecords)}
        </section>

        ${
          subs.cancelled.length
            ? `<section>
          <h2>已取消<span class="count">${subs.cancelled.length} 项</span></h2>
          <div class="panel">
${subs.cancelled
  .map(
    (c) => `            <div class="sub-row" style="grid-template-columns:44px 1fr auto">
              <span class="logo tone-5">${esc(monogram(c.name))}</span>
              <div class="sub-name"><div class="sub-title">${esc(c.name)}</div><div class="sub-meta">取消于 ${esc(c.cancelledAt)}</div></div>
              <div class="cell muted">${esc(c.note)}</div>
            </div>`
  )
  .join("\n")}
          </div>
        </section>`
            : ""
        }

        <div class="note">
          <div>
            <b>口径：</b>金额按订阅原始币种展示，不做汇率折算；月度成本 = 年付 ÷ 12、月付原值，年度成本 = 月度 × 12。
            「下次扣费」按构建日期（Asia/Shanghai）向前推算。扣费记录从 beancount 交易里按收款方自动匹配到订阅，
            <b>本页只读</b>——改账本或台账后 push，GitHub Actions 会重新构建并发布。
          </div>
        </div>`;

  return layout({
    title: "订阅 · 个人账本",
    description: `个人账本订阅总览：${active.length} 个在用订阅，月度 ${totalsLine(monthly)}，年度 ${totalsLine(yearly)}。`,
    active: "subscriptions",
    body,
    builtAt,
    commit,
  });
}

// ---------- 耗材页 ----------

function consumablesPage({ consumables, records, todayISO, builtAt, commit }) {
  const inUse = consumables.inUse;
  const used = consumables.used;
  const invested = sumByCurrency(inUse, "amount");
  const dailyTotal = sumByCurrency(inUse, "dailyCost");
  const investedEntries = orderCurrencies(invested);
  const dailyEntries = orderCurrencies(dailyTotal);
  const oldest = inUse.slice().sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  const trackedDays = oldest ? Math.max(...inUse.map((c) => c.days)) : 0;

  const consumableRecords = records.filter((r) => r.account.startsWith("Expenses:Consumables"));

  const cards = inUse.length
    ? `        <div class="con-grid">
${inUse
  .map(
    (c) => `          <article class="con-card">
            <div class="con-top">
              ${logoHtml(c)}
              <div>
                <div class="con-name">${esc(c.name)}</div>
                <div class="con-meta">购于 ${esc(c.date)} · ${esc(c.channel)}</div>
              </div>
            </div>
            <div class="con-price">${fmtMoney(c.amount, c.currency)}</div>
            <div class="con-foot">
              <span>已用 <b data-days-since="${c.date}">${c.days}</b> 天</span>
              <span>日均成本 <b>${fmtMoney(c.dailyCost, c.currency)}</b></span>
            </div>
            ${c.note ? `<p class="con-note">${esc(c.note)}</p>` : ""}
          </article>`
  )
  .join("\n")}
        </div>`
    : emptyState("暂无在用耗材", "在 consumables.md 的「在用」表里加一行，下次构建就会出现。");

  const usedPanel = used.length
    ? `      <div class="panel table-wrap">
        <table>
          <thead>
            <tr><th>耗材</th><th>上次购买日</th><th>换新日</th><th>用了多少天</th><th>日均成本</th><th>备注</th></tr>
          </thead>
          <tbody>
${used
  .map(
    (u) => `          <tr>
            <td class="t-title">${esc(u.name)}</td>
            <td class="date">${esc(u.lastBought)}</td>
            <td class="date">${esc(u.replacedAt)}</td>
            <td>${esc(u.days)}</td>
            <td class="num">${esc(u.dailyCost)}</td>
            <td class="cell muted">${esc(u.note)}</td>
          </tr>`
  )
  .join("\n")}
          </tbody>
        </table>
      </div>`
    : emptyState("还没有换新记录", "下次买同款时，把「在用」那行移到 consumables.md 的「已用完」表，这里会自动统计用了多少天、日均成本多少。");

  const body = `        <div class="page-head">
          <h1>耗材</h1>
          <p class="subtitle">${inUse.length} 件在用耗材，按 <b>日均成本 = 价格 ÷ 已用天数</b> 跟踪，换新时回来对比值不值。</p>
        </div>

        <div class="stat-strip">
${statCard({ label: "在用耗材", value: `${inUse.length}<span class="unit"> 件</span>`, sub: oldest ? `最早购于 ${oldest.date}` : "—" })}
${statCard({ label: "累计投入", value: investedEntries[0] ? fmtMoney(investedEntries[0].amount, investedEntries[0].currency) : "—", accent: true, sub: investedEntries.length > 1 ? investedEntries.slice(1).map((e) => fmtMoney(e.amount, e.currency)).join(" · ") : "按购买价合计" })}
${statCard({ label: "跟踪天数", value: `${trackedDays}<span class="unit"> 天</span>`, sub: oldest ? `自 ${oldest.date} 起算` : "—" })}
${statCard({ label: "当前日均成本", value: dailyEntries[0] ? fmtMoney(dailyEntries[0].amount, dailyEntries[0].currency) : "—", sub: dailyEntries.length > 1 ? dailyEntries.slice(1).map((e) => fmtMoney(e.amount, e.currency)).join(" · ") : "合计日均" })}
        </div>

        <section>
          <h2>在用耗材<span class="count">${inUse.length} 件</span></h2>
${cards}
        </section>

        <section>
          <h2>已用完<span class="count">${used.length} 条</span></h2>
${usedPanel}
        </section>

        <section>
          <h2>账本中的耗材支出<span class="count">${consumableRecords.length} 条</span></h2>
${recordsTable(consumableRecords, "耗材 / 摘要")}
        </section>

        <div class="note">
          <div>
            <b>口径：</b>已用天数从购买日算到构建当天（Asia/Shanghai），日均成本 = 价格 ÷ 已用天数；
            页面数据来自 consumables.md 与账本 <code>Expenses:Consumables</code> 科目，金额不做汇率折算。
          </div>
        </div>`;

  return layout({
    title: "耗材 · 个人账本",
    description: `个人账本耗材摊销：${inUse.length} 件在用，累计投入 ${totalsLine(invested)}，按日均成本跟踪。`,
    active: "consumables",
    body,
    builtAt,
    commit,
  });
}

// ---------- 主流程 ----------

function resolveToday() {
  if (process.env.SITE_TODAY) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(process.env.SITE_TODAY)) throw new Error("SITE_TODAY 需要 YYYY-MM-DD");
    return process.env.SITE_TODAY;
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function resolveCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function build() {
  const todayISO = resolveToday();
  const builtAt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());
  const commit = resolveCommit();

  const subs = loadSubscriptions(todayISO);
  const consumables = loadConsumables(todayISO);
  const records = loadExpenseRecords(subs.active, consumables.inUse);

  fs.rmSync(SITE_DIR, { recursive: true, force: true });
  fs.mkdirSync(SITE_DIR, { recursive: true });

  const pages = [
    {
      file: "index.html",
      html: subscriptionsPage({ subs, records, todayISO, builtAt, commit }),
    },
    {
      file: "consumables.html",
      html: consumablesPage({ consumables, records, todayISO, builtAt, commit }),
    },
  ];
  for (const page of pages) fs.writeFileSync(path.join(SITE_DIR, page.file), page.html, "utf8");

  fs.copyFileSync(path.join(ASSET_DIR, "styles.css"), path.join(SITE_DIR, "styles.css"));
  fs.copyFileSync(path.join(ASSET_DIR, "app.js"), path.join(SITE_DIR, "app.js"));
  fs.writeFileSync(path.join(SITE_DIR, ".nojekyll"), "");

  const subRecords = records.filter((r) => r.account.startsWith("Expenses:Subscription") || r.account.startsWith("Expenses:Phone"));
  console.log(`✓ 站点已生成：${path.relative(ROOT, SITE_DIR)}/`);
  console.log(`  · index.html        订阅 ${subs.active.length} 项 / 扣费记录 ${subRecords.length} 条`);
  console.log(`  · consumables.html  耗材 ${consumables.inUse.length} 件 / 支出记录 ${records.filter((r) => r.account.startsWith("Expenses:Consumables")).length} 条`);
  console.log(`  · 构建日期 ${todayISO}（Asia/Shanghai），提交 ${commit || "unknown"}`);
}

build();
