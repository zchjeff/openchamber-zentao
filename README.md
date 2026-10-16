# 禅道助手 · OpenChamber 扩展

在 OpenChamber 右侧栏打开「配置面板」，直接看禅道的 bug 列表，并一键把某条 bug 交给当前会话的 AI 去修。

```
右侧栏面板（沙箱 iframe）
        │  host.serviceRequest
        ▼
OpenChamber 主进程
        │  HTTP 127.0.0.1:<随机端口>  + Authorization: Bearer <token>
        ▼
本地服务进程 service/main.js  ──HTTPS──▶  你的禅道（index.php?m=…&f=…）
```

## 为什么是两段式

面板跑在 OpenChamber 的沙箱 iframe 里（origin 为 `null`），**不能直接访问网络**：禅道不会返回
`Access-Control-Allow-Origin: null`，而且禅道需要 `Referer` 同源 + `zentaosid` cookie，浏览器里根本发不出去。

所以禅道的所有 HTTP 交互都放在一个 **本地服务进程** 里（`contributes.service`）。这个进程不继承宿主环境变量，
host 会注入 `OPENCHAMBER_SERVICE_PORT` / `OPENCHAMBER_SERVICE_TOKEN`，并且**每个请求（含 `/health`）都必须带
正确的 Bearer token**，只监听 `127.0.0.1`。

## 目录

| 路径 | 说明 |
| --- | --- |
| `package.json` | 扩展清单（`openchamber` 字段就是 manifest） |
| `src/protocol.ts` | 面板 ↔ 服务共用的类型与路由表 |
| `src/service/zentao.ts` | 禅道协议客户端（登录 / 产品 / 成员 / 迭代 / bug 列表与详情 / 解决 / 关闭 / 激活） |
| `src/service/config.ts` | 配置读写：`~/.openchamber-zentao/config.json`（0600，原子写入） |
| `src/service.ts` | 本地服务入口：HTTP 路由 + 保活 + 过期自动重登 |
| `src/panel.ts` | 面板 UI |
| `panel/` | 构建产物 + `index.html` / `style.css` / `icon.svg`（**要提交进 git**） |
| `service/main.js` | 服务的构建产物（**要提交进 git**） |

## 开发

```bash
bun install
bunx tsc --noEmit     # 类型检查
bun run build         # 打两个包：panel/main.js（浏览器 IIFE）和 service/main.js（Node ESM）
```

OpenChamber **不会**帮你编译任何东西，所以每次改完源码都要 `bun run build` 再重新加载扩展。
构建依赖 Bun（`bunx openchamber-guest-bundle`）。

## 安装

1. OpenChamber → 设置 → 扩展
2. 把本目录的**绝对路径**粘进去 → 添加
3. 授权对话框里确认能力：`prompt`（发消息给当前会话）、`sessions`、`service`（本地服务）

> 只支持 OpenChamber Web 与桌面版；VS Code 与移动端不加载扩展。

## 使用

1. **连接禅道**：填地址（如 `https://bug.ethicall.cn`）、账号、密码 → 连接。
   如果已经有别处拿到的 `zentaosid`，也可以只填地址 + token 直接连。
   密码只存在本地服务自己的配置文件里（0600），面板只知道「已登录：谁」。
2. **筛选**：`项目（产品）` → `迭代`（该产品下可选的执行）→ `成员`，下拉都能单独刷新。
   `成员` 下拉由当前 `迭代` 的 bug 指派对象生成（不再是整个产品团队），顶部固定有 `全部`（不限成员）；
   切换迭代会一并重置它。
   `仅看我的` 只筛当前登录账号；它和 `成员` 是叠加的（都按指派对象过滤）。
3. **分类**：`未解决` / `已解决` / `已关闭` 三个**复选框**，标签带数量，可任意组合；
   一个都不勾表示「不限状态」。
4. **列表**：每行有
   - `预览`：弹出详情对话框（步骤、模块、平台、影响版本…）。点遮罩、按 `Esc` 或点「关闭」都能关掉。
   - `AI 修复`：**新建一个草稿会话**，把这条 bug 作为卡片挂上去（自带 bug 地址与上下文提示词），
     提示词先放进输入框等你确认，不会立刻发送。
   - `解决` / `关闭`：**先弹确认卡，显示将要提交的原始请求**，你确认后才写回禅道
   - `禅道`：在浏览器里打开这条 bug

   工具栏的「新会话里直接发送」开关：打开后 `AI 修复` 会在刚建好的新会话里**直接发送**提示词；
   默认关闭，只留下草稿会话。

## 斜杠命令

```
/zentao 3986
```

把 bug #3986 作为一张卡片挂到当前会话（和 GitHub / Linear 那张 chip 一样），卡片自带上下文提示词。

## 会话动作：回写禅道并标记已解决

AI 修完之后，在该会话的菜单里点「**回写禅道并标记已解决**」：

- 扩展读取这个会话的对话，自动把最后一条 AI 回复（修复结论）填进「处理备注」，
- 面板弹出**确认卡**（和「解决」一样会显示将要提交的原始请求），你确认后才
  `POST m=bug&f=resolve` 写回禅道，并把状态改为**已解决**。不会自动提交。

> 这个动作会读取会话消息，需要 **`conversation`** 能力。首次使用请在 设置 → 扩展 里再授权一次。
> 如果会话里找不到 bug 号，面板会提示，不会乱写。

## 会话保活

服务每 10 分钟 ping 一次禅道。如果发现登录态失效，会用保存的密码自动重登一次再重试原请求；
面板底部会显示「状态：…」。没有保存密码时会明确提示需要重新登录，而不是悄悄显示空列表。

## 配置与诊断

- 配置：`~/.openchamber-zentao/config.json`（0600）。删掉它等于重置。
- 诊断：`GET /api/debug?query=m=bug&f=browse&product=37&t=json` 会原样返回禅道响应，
  用来排查不同禅道版本/部署的差异。

## 兼容性

- 走的是禅道的 web 端点（`index.php?m=…&f=…&t=json`），**不依赖 REST API**
  （`/api.php/v1/*` 在不少部署上被 nginx 挡掉）。
- 迭代下拉来自「创建 bug」页面里 `<select name="execution">` 的真实选项，没有硬编码任何产品/项目/成员。
- 列表的「迭代」「指派给」过滤：只有当服务端返回的对象里确实带这些字段时才在本地二次过滤，
  否则退回服务端过滤，避免老版本禅道被过滤成空列表。