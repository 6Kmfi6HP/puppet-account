# Puppet Account

FreeSocks 无头注册 SDK（仓库名 `puppet-account`）。协议层注册工具：无需人工打开 `/get-account` 页面完成免费号注册，作为后续 Telegram 机器人的基础库。

> **License**：[GPL-3.0-or-later](LICENSE)。

## 能力

| 步骤 | 实现 |
|---|---|
| Cap 人机验证 | Playwright 真实 Chromium（生产 Cap **强制 instrumentation**，纯 PoW 会被拒） |
| `POST /api/v1/account` | HPKE reveal-leg（`fsRespEph`）+ PoP 公钥绑定 |
| `POST /api/v1/account/connection-mode` | `fs_session` cookie + PoP 签名 |
| `POST /api/v1/account/regenerate` | reveal 解封订阅 URL |

也可传入已有 `captchaToken`，完全跳过浏览器（适合 bot 侧另路拿 token）。

## 硬约束（来自研究报告）

1. **Cap instrumentation**：`challenge → WASM PoW → redeem` 在生产上必须附带浏览器 iframe 产出的 `instr`，否则 `missing_instrumentation_response`。默认 **headed** Chromium。
2. **IP 配额**：`freetier.create` = **3 号 / IP / 天**。
3. **账号号只揭示一次**：`accountId` 为 32 位数字，务必保存。

## 安装

```bash
cd sdk
bun install
bunx playwright install chromium   # 仅 Cap 浏览器路径需要
```

运行时 `bun >= 1.3`（见 `package.json` engines）。

## CLI

```bash
# 完整注册（Cap 弹 Chromium → 建号 → 选模式 → 发密钥）
bun run register

# 只要账号号，不签发订阅
bun run register -- --account-only

# 外部已拿到 Cap token（TG bot 场景）
bun run register -- --token '<cap-token>' --json

# 指定推荐码 / 模式
bun run register -- --referral FSR-XXXX --mode freedom-ws

# 导出订阅：链接每行一个 + 订阅内容（对订阅 URL 的一次 GET 正文）分别追加到 txt
bun run register -- --save-link links.txt --save-content content.txt
```

`--save-link` / `--save-content` 均为追加写、不去重、UTF-8、每行一条；配合 `--json` 时结果里多出 `saves: { link, content }`，任一写入失败会以退出码 3 标记部分成功（账号本身不受影响）。`--account-only` 没有订阅 URL 时两个参数都会跳过。
完整参数见 `bun run register -- --help`。

## 作为库

```ts
import { registerAccount, FreeSocksClient, discoverPins } from '@freesocks-reverse/puppet-account';

// 一键注册
const account = await registerAccount({
  captchaToken,          // 可选；缺省则 headed Playwright 求解 Cap
  referralCode: 'FSR-…',
  modeId: 'freedom-ws',
});
// account.accountId / subscriptionUrl / sessionCookie / popSessionToken

// 或自行编排（TG bot 里按对话步骤拆开）
const pins = await discoverPins('https://freesocks.org');
const client = await FreeSocksClient.create({ baseUrl: 'https://freesocks.org', pins });
const created = await client.createAccount({ captchaToken });
await client.setConnectionMode('freedom-ws');
const sub = await client.regenerate();
```

## 目录

```
sdk/
├── bin/register.ts          # CLI 入口（fs-register）
├── src/
│   ├── register.ts          # registerAccount() 一键编排
│   ├── client.ts            # HTTP + reveal-leg + cookie jar + PoP 签名
│   ├── pop.ts               # Ed25519 PoP 会话（WebCrypto）
│   ├── pins.ts              # 从 SPA e2ee chunk 发现静态 HPKE kid
│   ├── pins.freesocks.json  # 生产 pins 兜底快照
│   ├── types.ts             # 公共类型 + SdkError
│   ├── exportSub.ts         # CLI 导出：订阅链接追加 / 订阅内容抓取
│   ├── export-sub.selftest.ts # 本地 HTTP 自测（离线）
│   ├── cap/
│   │   ├── browser.ts       # Playwright Cap（生产路径，默认 headed）
│   │   ├── pow.ts           # 纯 PoW solve（自托管无 instrumentation）
│   │   └── pow.selftest.ts  # 网络 smoke（CI 中仅提示，不拦截）
│   ├── crypto/              # 从 repo/src/shared/crypto 同步的加密原语
│   │   ├── envelope.ts      # 编解码 / 规范化 / 路由策略（无 KeySchedule，隔离安全）
│   │   ├── hpke.ts          # X-Wing HPKE（@hpke/core，unforked）
│   │   ├── channel.ts       # reveal-leg / seal 通道协议
│   │   └── pop.ts           # PoP 规范消息（客户端签名 / 服务端校验单一来源）
│   └── index.ts             # 公共导出
├── .github/workflows/ci.yml # typecheck（网络 smoke 不拦截合并）
├── LICENSE                  # GPL-3.0-or-later
└── package.json
```

加密原语 vendored 自 `repo/src/shared/crypto`：HPKE / envelope / PoP。

## 开发 / 验证

```bash
bun run typecheck       # tsc --noEmit
bun run test:cap-pow    # 网络 smoke：真实 challenge → WASM PoW（不 redeem 成功）
bun run test:export-sub # 离线自测：订阅链接/内容 txt 导出
```

## 错误码

所有失败抛 `SdkError`（`{ code, message, status?, details? }`）。SDK 内部抛出与来自服务端 `error.code` 透传的 HTTP 错误码如下：

| code | 含义 |
|---|---|
| `cap.challenge_failed` | Cap challenge 请求非 2xx（HTTP status 透传） |
| `cap.challenge_shape` | challenge 响应结构无法识别 |
| `cap.redeem_failed` | redeem 未 `success` 或无 token（含服务端 error/reason） |
| `cap.browser_failed` | Playwright 启动/求解抛异常 |
| `cap.timeout` | 等待后端 Cap redeem 超时 |
| `cap.instr_blocked` | redeem 被 instrumentation 拒绝（生产很常见） |
| `cap.token_required` | captcha 策略为 `none` 时仍要求 token |
| `pins.index_failed` | SPA 首页抓取失败 |
| `pins.not_found` | 从 SPA assets 中未能发现 HPKE pins |
| `pins.missing_kid` | 缺少 `hpkeKid`，无法打开信封响应 |
| `auth.no_cookie` | 账号已建但未收到 `fs_session` cookie |
| `sub.fetch_failed` | 订阅内容抓取网络异常（CLI `--save-content`） |
| `sub.http` | 订阅链接抓取返回非 2xx（CLI `--save-content`） |
| `sub.empty` | 订阅链接抓取返回空正文（CLI `--save-content`） |
| `network` | fetch 网络异常 |
| `http.<status>` | 服务端返回非 2xx（如 `http.401`） |
| `aborted` | 调用方 `AbortSignal` 终止 |

## FAQ

- **为什么默认 headed？** 生产 Cap 会检测 headless 指纹并把纯协议 PoW 判为 `missing_instrumentation_response`。`--headless` 可试，但通常失败。
- **什么是 instrumentation？** Cap 在浏览器 iframe 里产出的一小段 `instr` blob，随 redeem 一起提交；绕过它就等于绕过人机验证校验，故被拒。
- **纯 PoW 何时可用？** 自托管、未开 instrumentation 的 Cap 实例（或本地反弹测试）。对 freesocks.org 生产域无效。
- **怎么不开浏览器拿 token？** 由 bot 侧用其它途径求解 Cap 得到 `captchaToken`，再 `--token` 或传 `captchaToken` 即可完全跳过浏览器步骤。
- **账号能建几个？** 免费号 `freetier.create` 按 IP 配额 **3 号/天**；超限会收到服务端配额错误。
- **`accountId` 只显示一次？** 服务端设计：账号号仅在创建时揭示。务必保存，之后通过 `shortUuid`/订阅 URL 管理。
- **HPKE pins 从哪来？** 每次调用 `discoverPins` 从线上 SPA 的 e2ee chunk 现抓；抓不到时回退到 `pins.freesocks.json` 快照。