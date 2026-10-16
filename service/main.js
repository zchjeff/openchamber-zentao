// src/service.ts
import { createServer } from "node:http";

// src/protocol.ts
var ROUTES = {
  health: "/health",
  config: "/api/config",
  session: "/api/session",
  login: "/api/login",
  logout: "/api/logout",
  products: "/api/products",
  executions: "/api/executions",
  members: "/api/members",
  bugs: "/api/bugs",
  bug: "/api/bug",
  resolve: "/api/bug/resolve",
  close: "/api/bug/close",
  activate: "/api/bug/activate",
  keepalive: "/api/keepalive",
  debug: "/api/debug"
};

// src/service/config.ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
var CONFIG_DIR = join(homedir(), ".openchamber-zentao");
var CONFIG_PATH = join(CONFIG_DIR, "config.json");
var EMPTY_CONFIG = {
  base: "",
  account: "",
  password: "",
  token: "",
  realname: "",
  product: "",
  execution: "",
  memberAccount: "",
  resolvedBuild: "trunk"
};
var STRING_KEYS = [
  "base",
  "account",
  "password",
  "token",
  "realname",
  "product",
  "execution",
  "memberAccount",
  "resolvedBuild"
];
async function loadConfig() {
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...EMPTY_CONFIG };
    }
    const record = parsed;
    const config = { ...EMPTY_CONFIG };
    for (const key of STRING_KEYS) {
      const value = record[key];
      if (typeof value === "string")
        config[key] = value;
    }
    return config;
  } catch {
    return { ...EMPTY_CONFIG };
  }
}
async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 448 });
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}
`, {
    encoding: "utf8",
    mode: 384
  });
  await rename(temporary, CONFIG_PATH);
  try {
    await chmod(CONFIG_PATH, 384);
  } catch {}
}
function pickPatch(body) {
  const patch = {};
  for (const key of STRING_KEYS) {
    const value = body[key];
    if (typeof value === "string")
      patch[key] = value;
  }
  return patch;
}

// src/service/zentao.ts
import { createHash, randomUUID } from "node:crypto";

class ZentaoError extends Error {
  kind;
  constructor(message, kind = "unknown") {
    super(message);
    this.name = "ZentaoError";
    this.kind = kind;
  }
}
var USER_AGENT = "openchamber-zentao-assistant/0.1";
var ZENTAO_TIMEOUT_MS = 15000;
var MAX_BROWSE_PAGES = 20;
var BROWSE_PAGE_SIZE = 100;
function normaliseBase(base) {
  const trimmed = (base ?? "").trim().replace(/\/+$/, "");
  if (!trimmed)
    throw new ZentaoError("禅道地址为空", "config");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ZentaoError("禅道地址需要以 http:// 或 https:// 开头", "config");
  }
  return trimmed;
}
function encodeForm(form) {
  const params = new URLSearchParams;
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined)
      continue;
    if (Array.isArray(value)) {
      for (const item of value)
        params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}
var md5 = (value) => createHash("md5").update(value, "utf8").digest("hex");
var uid = () => randomUUID().replace(/-/g, "");
function today() {
  const now = new Date;
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function looksLikeLogin(text) {
  const head = text.slice(0, 6000);
  if (/m=user&f=login/.test(head))
    return true;
  return /name=["']?account["']?/.test(head) && /name=["']?password["']?/.test(head);
}
function parseJson(text) {
  const raw = text.replace(/^\uFEFF/, "").trim();
  if (!raw) {
    throw new ZentaoError("禅道返回空响应：会话可能已失效，或 POST 请求体被 CSRF 校验丢弃", "auth");
  }
  try {
    return JSON.parse(raw);
  } catch {
    if (looksLikeLogin(raw)) {
      throw new ZentaoError("禅道要求重新登录（token 已失效）", "auth");
    }
    throw new ZentaoError(`禅道返回了非 JSON 内容：${raw.slice(0, 200)}`, "parse");
  }
}
function looksLikeLoginRedirect(payload) {
  const record = asRecord(payload);
  if (!record)
    return false;
  const locate = record["locate"];
  return typeof locate === "string" && /f=login/i.test(locate);
}
function unwrap(payload) {
  let current = payload;
  for (let depth = 0;depth < 4; depth += 1) {
    if (looksLikeLoginRedirect(current)) {
      throw new ZentaoError("禅道要求重新登录（token 已失效）", "auth");
    }
    const record = asRecord(current);
    if (!record)
      return current;
    if (record.status === "failed") {
      throw new ZentaoError(`禅道拒绝了本次请求：${String(record.reason ?? record.message ?? "未知原因")}`);
    }
    if (record.status !== "success" || !("data" in record))
      return current;
    let inner = record.data;
    if (typeof inner === "string") {
      try {
        inner = JSON.parse(inner);
      } catch {
        return inner;
      }
    }
    current = inner;
  }
  return current;
}
function asList(value) {
  if (Array.isArray(value))
    return value;
  if (value && typeof value === "object")
    return Object.values(value);
  return [];
}
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  return value;
}
function text(value) {
  if (value === null || value === undefined)
    return "";
  if (typeof value === "string")
    return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}
var ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#34": '"'
};
function decodeEntities(value) {
  return value.replace(/&(#?\w+);/g, (match, name) => ENTITIES[name] ?? match);
}
function htmlToText(html) {
  if (!html)
    return "";
  return decodeEntities(html.replace(/<\s*br\s*\/?\s*>/gi, `
`).replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|td)\s*>/gi, `
`).replace(/<[^>]*>/g, "")).replace(/[ \t]+\n/g, `
`).replace(/\n{3,}/g, `

`).trim();
}
function toOptions(container, take) {
  if (Array.isArray(container)) {
    const out = [];
    for (const entry of container) {
      const record = asRecord(entry);
      if (!record)
        continue;
      const option = take(record, "");
      if (option.id)
        out.push(option);
    }
    return out;
  }
  const record = asRecord(container);
  if (!record)
    return [];
  const out = [];
  for (const [key, value] of Object.entries(record)) {
    const inner = asRecord(value);
    const option = inner ? take(inner, key) : { id: key, name: typeof value === "string" ? value : key };
    if (option.id && option.id !== "0")
      out.push(option);
  }
  return out;
}
function extractSelect(html, name) {
  const selectRe = new RegExp(`<select[^>]*\\bname=["']?${name}\\[?\\]?["']?[^>]*>([\\s\\S]*?)<\\/select>`, "i");
  const select = selectRe.exec(html);
  if (!select?.[1])
    return [];
  const options = [];
  const tokenRe = /<optgroup[^>]*\blabel=["']([^"']*)["'][^>]*>|<option[^>]*\bvalue=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let group = "";
  let match;
  while ((match = tokenRe.exec(select[1])) !== null) {
    if (match[1] !== undefined) {
      group = decodeEntities(match[1]).trim();
      continue;
    }
    const id = decodeEntities(match[2] ?? "").trim();
    const label = decodeEntities((match[3] ?? "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (id && id !== "0")
      options.push({ id, name: label || id, group });
  }
  return options;
}
function personName(label, fallback) {
  const stripped = label.replace(/^\s*[A-Za-z]{1,3}\s*:\s*/, "").trim();
  return stripped || label || fallback;
}
function toBug(raw, base) {
  const id = text(raw.id ?? raw.bugID);
  return {
    id,
    title: text(raw.title),
    status: text(raw.status),
    type: text(raw.type),
    pri: text(raw.pri),
    severity: text(raw.severity),
    assignedTo: text(raw.assignedTo),
    openedBy: text(raw.openedBy),
    openedDate: text(raw.openedDate),
    execution: text(raw.execution),
    product: text(raw.product),
    url: `${base}/index.php?m=bug&f=view&bugID=${encodeURIComponent(id)}`
  };
}

class Zentao {
  base;
  token;
  timeoutMs;
  constructor(base, token, timeoutMs = ZENTAO_TIMEOUT_MS) {
    this.base = normaliseBase(base);
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
  get sessionToken() {
    return this.token;
  }
  set sessionToken(value) {
    this.token = value;
  }
  headers(referer) {
    return {
      Cookie: `zentaosid=${this.token}`,
      Token: this.token,
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      Referer: referer || `${this.base}/index.php`
    };
  }
  async raw(query, form, referer) {
    const url = `${this.base}/index.php?${query}`;
    const body = form === undefined ? undefined : encodeForm(form);
    const headers = this.headers(referer);
    if (body !== undefined)
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    let response;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ZentaoError(`无法连接 ${this.base}：${detail}`, "network");
    }
    return await response.text();
  }
  async call(query, form, referer) {
    return unwrap(parseJson(await this.raw(query, form, referer)));
  }
  async products() {
    const inner = await this.call("m=product&f=all&t=json");
    const record = asRecord(inner);
    const take = (entry, fallbackId) => ({
      id: text(entry.id ?? entry.value ?? fallbackId),
      name: text(entry.name ?? entry.title ?? entry.label ?? fallbackId)
    });
    const fromStats = toOptions(record?.["productStats"], take).filter((option) => option.id && option.name);
    if (fromStats.length) {
      return fromStats.map((option) => ({ id: option.id, name: option.name }));
    }
    return toOptions(record?.["products"] ?? inner, take).filter((option) => /^\d+$/.test(option.id)).map((option) => ({ id: option.id, name: option.name }));
  }
  async members() {
    const inner = await this.call("m=company&f=browse&t=json");
    const container = asRecord(inner)?.["users"] ?? inner;
    const out = [];
    for (const entry of asList(container)) {
      const record = asRecord(entry);
      if (!record)
        continue;
      const account = text(record.account);
      if (!account)
        continue;
      out.push({ id: text(record.id), account, realname: text(record.realname) });
    }
    return out;
  }
  async productContext(productId) {
    const product = text(productId).trim();
    if (!product)
      return { executions: [], members: [] };
    const query = `m=bug&f=create&product=${encodeURIComponent(product)}`;
    const html = await this.raw(query, undefined, `${this.base}/index.php?${query}`);
    if (looksLikeLogin(html)) {
      throw new ZentaoError("禅道要求重新登录（token 已失效）", "auth");
    }
    const executions = extractSelect(html, "execution").map((option) => ({
      id: option.id,
      name: option.group ? `${option.group} / ${option.name}` : option.name
    }));
    let members = extractSelect(html, "assignedTo").map((option) => ({
      id: option.id,
      account: option.id,
      realname: personName(option.name, option.id)
    }));
    if (!members.length)
      members = await this.members();
    return { executions, members };
  }
  browseQuery(product, pageID, recTotal) {
    return new URLSearchParams({
      m: "bug",
      f: "browse",
      product,
      t: "json",
      branch: "0",
      browseType: "unclosed",
      param: "0",
      orderBy: "id_desc",
      recTotal: String(recTotal),
      recPerPage: String(BROWSE_PAGE_SIZE),
      pageID: String(pageID)
    }).toString();
  }
  async fetchAll(product) {
    const bugs = [];
    const seen = new Set;
    let recTotal = 0;
    for (let pageID = 1;pageID <= MAX_BROWSE_PAGES; pageID += 1) {
      const inner = await this.call(this.browseQuery(product, pageID, recTotal));
      const pager = asRecord(asRecord(inner)?.["pager"]);
      const reported = Number(pager?.["recTotal"] ?? 0);
      if (Number.isFinite(reported) && reported > 0)
        recTotal = reported;
      const page = asList(asRecord(inner)?.["bugs"] ?? inner).map((entry) => asRecord(entry)).filter((entry) => entry !== null).map((entry) => toBug(entry, this.base)).filter((bug) => {
        if (!bug.id || seen.has(bug.id))
          return false;
        seen.add(bug.id);
        return true;
      });
      bugs.push(...page);
      if (!page.length)
        break;
      const pageTotal = Number(pager?.["pageTotal"] ?? 0);
      if (Number.isFinite(pageTotal) && pageTotal > 0 && pageID >= pageTotal)
        break;
      if (recTotal && bugs.length >= recTotal)
        break;
    }
    return { bugs, truncated: recTotal > bugs.length };
  }
  async bugs(query) {
    const product = text(query.product).trim();
    if (!product)
      throw new ZentaoError("请先选择项目（产品）", "config");
    const { bugs: all, truncated } = await this.fetchAll(product);
    let matched = all;
    const execution = text(query.execution).trim();
    if (execution && all.some((bug) => bug.execution)) {
      matched = matched.filter((bug) => bug.execution === execution);
    }
    const assignedTo = text(query.assignedTo).trim();
    if (assignedTo && all.some((bug) => bug.assignedTo)) {
      matched = matched.filter((bug) => bug.assignedTo === assignedTo);
    }
    const status = query.status;
    const found = status ? matched.filter((bug) => bug.status === status) : matched;
    return { bugs: found, total: found.length, truncated };
  }
  async bug(id) {
    const bugId = text(id).trim();
    if (!bugId)
      throw new ZentaoError("缺少 bugID", "config");
    const inner = await this.call(`m=bug&f=view&bugID=${encodeURIComponent(bugId)}&t=json`);
    const record = asRecord(asRecord(inner)?.["bug"] ?? inner);
    if (!record)
      throw new ZentaoError(`未找到 bug #${bugId}`, "notfound");
    return {
      ...toBug(record, this.base),
      steps: htmlToText(text(record.steps)),
      module: text(record.module),
      project: text(record.project),
      os: text(record.os),
      browser: text(record.browser),
      openedBuild: text(record.openedBuild),
      resolution: text(record.resolution),
      resolvedBy: text(record.resolvedBy),
      resolvedDate: text(record.resolvedDate)
    };
  }
  bugReferer(bugId) {
    return `${this.base}/index.php?m=bug&f=view&bugID=${encodeURIComponent(bugId)}`;
  }
  async resolve(id, comment, options = {}) {
    const bugId = text(id).trim();
    if (!bugId)
      throw new ZentaoError("缺少 bugID", "config");
    return this.call(`m=bug&f=resolve&bugID=${encodeURIComponent(bugId)}&t=json`, {
      uid: uid(),
      status: "resolved",
      resolution: options.resolution || "resolved",
      resolvedBuild: options.resolvedBuild || "trunk",
      resolvedDate: today(),
      comment: comment || ""
    }, this.bugReferer(bugId));
  }
  async close(id, comment) {
    const bugId = text(id).trim();
    if (!bugId)
      throw new ZentaoError("缺少 bugID", "config");
    return this.call(`m=bug&f=close&bugID=${encodeURIComponent(bugId)}&t=json`, { uid: uid(), status: "closed", comment: comment || "" }, this.bugReferer(bugId));
  }
  async activate(id, comment, assignedTo) {
    const bugId = text(id).trim();
    if (!bugId)
      throw new ZentaoError("缺少 bugID", "config");
    let openBuilds = ["trunk"];
    try {
      const detail = await this.bug(bugId);
      const split = detail.openedBuild.split(",").map((entry) => entry.trim()).filter(Boolean);
      if (split.length)
        openBuilds = split;
    } catch {}
    return this.call(`m=bug&f=activate&bugID=${encodeURIComponent(bugId)}&t=json`, {
      uid: uid(),
      status: "active",
      assignedTo: assignedTo || "",
      "openedBuild[]": openBuilds,
      comment: comment || ""
    }, this.bugReferer(bugId));
  }
  async profile() {
    const inner = await this.call("m=user&f=profile&t=json");
    const record = asRecord(asRecord(inner)?.["user"] ?? inner);
    if (!record)
      return null;
    return {
      id: text(record.id),
      account: text(record.account),
      realname: text(record.realname)
    };
  }
}
function collectCookies(response, jar) {
  const headers = response.headers;
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (!lines.length) {
    const single = response.headers.get("set-cookie");
    if (single)
      lines.push(single);
  }
  for (const line of lines) {
    for (const part of line.split(/,(?=[^;=,\s]+=)/)) {
      const pair = part.split(";")[0] ?? "";
      const equals = pair.indexOf("=");
      if (equals <= 0)
        continue;
      jar.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
    }
  }
}
function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
async function login(base, account, password, timeoutMs = ZENTAO_TIMEOUT_MS) {
  const root = normaliseBase(base);
  if (!account.trim())
    throw new ZentaoError("禅道账号为空", "config");
  if (!password)
    throw new ZentaoError("禅道密码为空", "config");
  const loginUrl = `${root}/index.php?m=user&f=login`;
  const jar = new Map;
  const send = async (url, init) => {
    let response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ZentaoError(`无法连接 ${root}：${detail}`, "network");
    }
    collectCookies(response, jar);
    return await response.text();
  };
  await send(loginUrl, { headers: { "User-Agent": USER_AGENT } });
  const rand = (await send(`${root}/index.php?m=user&f=refreshRandom`, {
    headers: { "User-Agent": USER_AGENT, Referer: loginUrl }
  })).trim();
  const form = {
    account: account.trim(),
    password: rand ? md5(md5(password) + rand) : md5(password),
    passwordStrength: "1",
    referer: "/",
    keepLogin: "1",
    captcha: ""
  };
  if (rand)
    form.verifyRand = rand;
  const body = await send(loginUrl, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/plain, */*",
      Referer: loginUrl,
      Cookie: cookieHeader(jar)
    },
    body: encodeForm(form)
  });
  let parsed;
  try {
    parsed = JSON.parse(body.replace(/^\uFEFF/, "").trim());
  } catch {
    throw new ZentaoError(`登录响应不是 JSON：${body.slice(0, 200)}`, "parse");
  }
  const record = asRecord(parsed);
  if (record?.["result"] === "fail") {
    throw new ZentaoError(`登录失败：${text(record["message"]) || "账号或密码错误"}`, "auth");
  }
  let token = jar.get("zentaosid") || "";
  if (!token && typeof record?.["locate"] === "string") {
    const locate = record["locate"];
    if (locate.startsWith(root)) {
      await send(locate, {
        headers: {
          "User-Agent": USER_AGENT,
          Referer: loginUrl,
          Cookie: cookieHeader(jar)
        }
      });
      token = jar.get("zentaosid") || "";
    }
  }
  if (!token)
    throw new ZentaoError("登录成功但没有拿到 zentaosid 会话", "auth");
  let realname = "";
  try {
    const who = await new Zentao(root, token, timeoutMs).profile();
    realname = who?.realname ?? "";
  } catch {}
  return { token, account: account.trim(), realname };
}

// src/service.ts
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? "");
var SERVICE_TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var KEEP_ALIVE_MS = 10 * 60 * 1000;
var CACHE_MS = 30 * 1000;
var MAX_BODY_BYTES = 1024 * 1024;
if (!PORT) {
  console.error("[zentao] OPENCHAMBER_SERVICE_PORT is missing; refusing to start");
  process.exit(1);
}

class Runtime {
  config = { ...EMPTY_CONFIG };
  keepAlive = null;
  client = null;
  cache = new Map;
  async init() {
    this.config = await loadConfig();
    this.rebuild();
  }
  rebuild() {
    this.client = this.config.base && this.config.token ? new Zentao(this.config.base, this.config.token) : null;
    this.cache.clear();
  }
  invalidate() {
    this.cache.clear();
  }
  require() {
    if (!this.client) {
      throw new ZentaoError(this.config.token ? "请先填写禅道地址" : "尚未登录禅道", "config");
    }
    return this.client;
  }
  async save(patch) {
    this.config = { ...this.config, ...patch };
    await saveConfig(this.config);
    this.rebuild();
  }
  async signIn(base, account, password) {
    const result = await login(base, account, password);
    await this.save({
      base: normaliseBase(base),
      account: result.account,
      password,
      token: result.token,
      realname: result.realname
    });
    this.keepAlive = { ok: true, at: Date.now(), message: "已连接禅道" };
  }
  async relogin() {
    const { base, account, password } = this.config;
    if (!base || !account || !password) {
      throw new ZentaoError("会话已失效，且没有保存密码，请重新登录", "auth");
    }
    await this.signIn(base, account, password);
  }
  async run(operation) {
    try {
      return await operation(this.require());
    } catch (error) {
      if (error instanceof ZentaoError && error.kind === "auth") {
        await this.relogin();
        this.keepAlive = { ok: true, at: Date.now(), message: "会话已过期，已自动重新登录" };
        return await operation(this.require());
      }
      throw error;
    }
  }
  async refresh(key, force, produce) {
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_MS)
      return hit.value;
    const value = await produce();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
  async keepAliveNow() {
    if (!this.client)
      return;
    try {
      const profile = await this.run((client) => client.profile());
      const who = profile?.realname || profile?.account || "";
      this.keepAlive = {
        ok: true,
        at: Date.now(),
        message: who ? `禅道会话保活成功（${who}）` : "禅道会话保活成功"
      };
    } catch (error) {
      this.keepAlive = {
        ok: false,
        at: Date.now(),
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
var runtime = new Runtime;
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}
function ok(data) {
  return { ok: true, data };
}
function fail(res, error) {
  const kind = error instanceof ZentaoError ? error.kind : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  send(res, kind === "auth" ? 401 : kind === "notfound" ? 404 : 500, {
    ok: false,
    error: message,
    kind
  });
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES)
      throw new ZentaoError("请求体过大", "unsupported");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw)
    return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new ZentaoError("请求体不是合法 JSON", "unsupported");
  }
}
function configView(config) {
  return {
    base: config.base,
    account: config.account,
    realname: config.realname,
    product: config.product,
    execution: config.execution,
    memberAccount: config.memberAccount,
    resolvedBuild: config.resolvedBuild,
    hasPassword: Boolean(config.password),
    hasToken: Boolean(config.token)
  };
}
function asBugStatus(value) {
  return value === "active" || value === "resolved" || value === "closed" ? value : "";
}
async function handle(req, res, url, body) {
  const query = (key) => url.searchParams.get(key) ?? "";
  const field = (key, fallback = "") => {
    const value = body[key];
    return typeof value === "string" ? value : fallback;
  };
  const force = query("refresh") === "1";
  switch (url.pathname) {
    case ROUTES.health:
      send(res, 200, ok({ ready: true, hasSession: Boolean(runtime.config.token) }));
      return;
    case ROUTES.session: {
      const view = {
        base: runtime.config.base,
        account: runtime.config.account,
        realname: runtime.config.realname,
        loggedIn: Boolean(runtime.config.base && runtime.config.token),
        keepAlive: runtime.keepAlive
      };
      send(res, 200, ok(view));
      return;
    }
    case ROUTES.config:
      if (req.method === "GET") {
        send(res, 200, ok(configView(runtime.config)));
        return;
      }
      await runtime.save(pickPatch(body));
      send(res, 200, ok(configView(runtime.config)));
      return;
    case ROUTES.login: {
      const token = field("token").trim();
      if (token) {
        const base = field("base", runtime.config.base);
        await runtime.save({ base: normaliseBase(base), token });
        const profile = await runtime.run((client) => client.profile());
        if (profile) {
          await runtime.save({
            account: profile.account,
            realname: profile.realname
          });
        }
        send(res, 200, ok(configView(runtime.config)));
        return;
      }
      const base = field("base", runtime.config.base) || runtime.config.base;
      const account = field("account", runtime.config.account) || runtime.config.account;
      const password = field("password") || runtime.config.password;
      await runtime.signIn(base, account, password);
      send(res, 200, ok(configView(runtime.config)));
      return;
    }
    case ROUTES.logout:
      await runtime.save({ token: "", realname: "", password: "" });
      runtime.keepAlive = null;
      send(res, 200, ok(configView(runtime.config)));
      return;
    case ROUTES.products: {
      const products = await runtime.run((client) => client.products());
      const data = products;
      send(res, 200, ok(data));
      return;
    }
    case ROUTES.executions: {
      const product = query("product") || field("product") || runtime.config.product;
      const context = await runtime.refresh(`context:${product}`, force, () => runtime.run((client) => client.productContext(product)));
      send(res, 200, ok(context));
      return;
    }
    case ROUTES.members: {
      const members = await runtime.refresh("members", force, () => runtime.run((client) => client.members()));
      send(res, 200, ok(members));
      return;
    }
    case ROUTES.bugs: {
      const data = await runtime.run((client) => client.bugs({
        product: query("product") || runtime.config.product,
        execution: query("execution"),
        status: asBugStatus(query("status")),
        assignedTo: query("assignedTo")
      }));
      send(res, 200, ok(data));
      return;
    }
    case ROUTES.bug: {
      const id = query("id") || field("id");
      const data = await runtime.run((client) => client.bug(id));
      send(res, 200, ok(data));
      return;
    }
    case ROUTES.resolve: {
      const id = field("id") || query("id");
      const data = await runtime.run((client) => client.resolve(id, field("comment"), {
        resolution: field("resolution", "resolved"),
        resolvedBuild: field("resolvedBuild", runtime.config.resolvedBuild)
      }));
      runtime.invalidate();
      send(res, 200, ok({ result: "ok", raw: data }));
      return;
    }
    case ROUTES.close: {
      const id = field("id") || query("id");
      const data = await runtime.run((client) => client.close(id, field("comment")));
      runtime.invalidate();
      send(res, 200, ok({ result: "ok", raw: data }));
      return;
    }
    case ROUTES.activate: {
      const id = field("id") || query("id");
      const data = await runtime.run((client) => client.activate(id, field("comment"), field("assignedTo")));
      runtime.invalidate();
      send(res, 200, ok({ result: "ok", raw: data }));
      return;
    }
    case ROUTES.keepalive:
      await runtime.keepAliveNow();
      send(res, 200, ok(runtime.keepAlive));
      return;
    case ROUTES.debug: {
      const rawQuery = query("query") || field("query");
      if (!rawQuery)
        throw new ZentaoError("缺少 query 参数", "config");
      const text = await runtime.run((client) => client.raw(rawQuery));
      send(res, 200, ok({ query: rawQuery, body: text.slice(0, 20000) }));
      return;
    }
    default:
      send(res, 404, { ok: false, error: `未知路由 ${url.pathname}`, kind: "notfound" });
  }
}
var server = createServer((req, res) => {
  (async () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
      send(res, 401, { ok: false, error: "unauthorized", kind: "auth" });
      return;
    }
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readBody(req);
      await handle(req, res, url, body);
    } catch (error) {
      fail(res, error);
    }
  })();
});
await runtime.init();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[zentao] service ready on 127.0.0.1:${PORT}`);
});
var timer = setInterval(() => {
  runtime.keepAliveNow();
}, KEEP_ALIVE_MS);
timer.unref?.();
setTimeout(() => {
  runtime.keepAliveNow();
}, 1500).unref?.();
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref?.();
  });
}
