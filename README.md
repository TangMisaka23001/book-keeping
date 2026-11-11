# 个人账本（纯文本复式记账）

Beancount 格式的纯文本账本，用 Git 友好的 `.bean` 文件记录每一笔钱。
**核心原则：每笔交易至少两条 posting，金额相加必须为 0**——这样账目永远能自己校验。

## 目录结构

```
bookkeeping/
├── main.bean                 根文件：标题、币种、include 其他文件
├── accounts.bean             账户表：所有账户先在这里 open 才能用
├── transactions/
│   └── 2026-11.bean          交易：按月一个文件
├── subscriptions.md          订阅台账（页面数据源之一）
├── consumables.md            耗材台账（页面数据源之一）
├── tools/
│   ├── ledger.mjs            本地校验 + 报表（替代 beancount 官方工具）
│   ├── ledger-core.mjs       解析核心（CLI 与站点生成器共用）
│   ├── build-site.mjs        把账本 + 台账渲染成静态页面
│   ├── site/                 页面样式与脚本（styles.css / app.js）
│   └── sync.sh               每日同步脚本（定时任务调用）
├── .github/workflows/pages.yml  push 后自动构建并发布 GitHub Pages
└── README.md
```

## 怎么记一笔

跟我说一声就行，例如：

- 「今天打车 32 块，支付宝付的」
- 「11 月房租 3500，招行卡转的」
- 「视频会员扣了 25，信用卡」
- 「发工资 20000 到招行」

我会：**先按格式给出条目草案 → 你确认 → 写进对应月份文件 → 跑校验**。
（这是 beancount skill 的规矩：不确认不写、不改历史条目。）

自己写的话，格式是：

```beancount
2026-11-10 * "地铁" "通勤"
  Expenses:Transport          6.00 CNY
  Assets:Alipay              -6.00 CNY
```

- 日期、`*`（已确认）或 `!`（待核实）、摘要
- posting 缩进两格：`账户 金额 币种`
- 最后一条 posting 可以省略金额，让程序自动配平（日常最常用）
- 账户名必须先在 `accounts.bean` 里 `open`

## 账户一览

| 账户 | 含义 |
|---|---|
| Assets:Bank:CMB / ICBC | 招行 / 工行储蓄卡 |
| Assets:Alipay / WeChat / Cash | 支付宝 / 微信零钱 / 现金 |
| Assets:Fund / Brokerage | 基金 / 证券账户 |
| Liabilities:CreditCard | 信用卡（欠款为负数） |
| Income:Salary / Bonus / Interest / Refund / Other | 收入类 |
| Expenses:Food / Transport / Housing / Shopping / Subscription / Health / Education / Entertainment / Fees / Uncategorized | 支出类 |
| Equity:OpeningBalances | 期初余额（首次建账时用） |

新增类别：在 `accounts.bean` 加一行 `2026-01-01 open Expenses:XXX CNY` 即可。

## 常用命令

```bash
cd /workspace/bookkeeping

node tools/ledger.mjs check          # 校验配平 + 账户是否存在
node tools/ledger.mjs report 2026-11 # 某月收支报表
node tools/ledger.mjs report         # 全部收支
node tools/ledger.mjs balance        # 各账户余额
node tools/build-site.mjs            # 生成静态页到 site/（本地预览用）
```

## 静态展示页（GitHub Pages）

订阅、耗材和真实扣费记录会自动发布成静态页面（Wallos 风格深色主题）：

- 订阅总览：https://tangmisaka23001.github.io/book-keeping/
- 耗材摊销：https://tangmisaka23001.github.io/book-keeping/consumables.html

### 怎么更新

每次 push 到 `main`（包括每日同步脚本的自动提交），GitHub Actions 会：

1. `node tools/ledger.mjs check` 校验账本——不配平会直接失败，**不会发布错误数据**；
2. `node tools/build-site.mjs` 生成 `site/`（构建产物不入库，见 `.gitignore`）；
3. 上传产物并部署到 GitHub Pages。

改 `subscriptions.md` / `consumables.md` / `transactions/*.bean` 后 push 即可，无需手工操作。
需要在 Actions 页面手动触发时，用 `workflow_dispatch`（Run workflow 按钮）。

### 本地预览

```bash
node tools/build-site.mjs
npx --yes serve site        # 或直接用浏览器打开 site/index.html
```

想固定某天来预览推算结果：`SITE_TODAY=2026-12-01 node tools/build-site.mjs`
（影响「下次扣费 / N 天后」和「已用天数 / 日均成本」）。

## 注意事项

- **金额带方向**：支出为正、对应资产为负；收入为负、对应资产为正。写反了校验会报「未配平」。
- **同一笔只记一次**：重复记录会让余额虚高，发现重复就删掉一条。
- **信用卡**：消费记 `Liabilities:CreditCard` 负数（欠款增加），还款时两边都写（见 `transactions/2026-11.bean` 注释里的例子）。
- **期初余额**：第一次用先把各账户实际余额录进去（对 `Equity:OpeningBalances`），之后才准。
- 本机没有 python/beancount/hledger，所以用 `tools/ledger.mjs` 校验；它能查配平、账户未 open、缺金额，够日常用。
