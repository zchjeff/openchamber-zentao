import { createHash, randomUUID } from 'node:crypto';
import type {
  Bug,
  BugDetail,
  BugList,
  BugStatus,
  ExecutionOption,
  MemberOption,
  ProductContext,
  ProductOption,
  ZtErrorKind,
} from '../protocol';

/**
 * A client for ZenTao's web endpoints (`index.php?m=…&f=…&t=json`).
 *
 * The REST API (`/api.php/v1`) is unavailable behind many deployments, so the
 * web endpoints are the portable surface: the same calls the browser itself
 * makes, which keeps this plugin working across ZenTao versions and instances
 * without anything instance-specific baked in.
 */

export class ZentaoError extends Error {
  readonly kind: ZtErrorKind;

  constructor(message: string, kind: ZtErrorKind = 'unknown') {
    super(message);
    this.name = 'ZentaoError';
    this.kind = kind;
  }
}

const USER_AGENT = 'openchamber-zentao-assistant/0.1';
/** Comfortably under the host's 20s serviceRequest timeout. */
export const ZENTAO_TIMEOUT_MS = 15000;
/** How deep into a product's bugs we are willing to walk before giving up. */
const MAX_BROWSE_PAGES = 20;
/** The page size asked of ZenTao; it decides for itself and reports it in `pager`. */
const BROWSE_PAGE_SIZE = 100;

type FormValue = string | number | Array<string | number> | undefined;
type Form = Record<string, FormValue>;

export function normaliseBase(base: string): string {
  const trimmed = (base ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new ZentaoError('禅道地址为空', 'config');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ZentaoError('禅道地址需要以 http:// 或 https:// 开头', 'config');
  }
  return trimmed;
}

function encodeForm(form: Form): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

const md5 = (value: string): string =>
  createHash('md5').update(value, 'utf8').digest('hex');

const uid = (): string => randomUUID().replace(/-/g, '');

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/* ------------------------------------------------------------------ parsing */

/** True when ZenTao answered with its login page instead of data. */
function looksLikeLogin(text: string): boolean {
  const head = text.slice(0, 6000);
  if (/m=user&f=login/.test(head)) return true;
  return /name=["']?account["']?/.test(head) && /name=["']?password["']?/.test(head);
}

function parseJson(text: string): unknown {
  const raw = text.replace(/^\uFEFF/, '').trim();
  if (!raw) {
    throw new ZentaoError(
      '禅道返回空响应：会话可能已失效，或 POST 请求体被 CSRF 校验丢弃',
      'auth',
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    if (looksLikeLogin(raw)) {
      throw new ZentaoError('禅道要求重新登录（token 已失效）', 'auth');
    }
    throw new ZentaoError(`禅道返回了非 JSON 内容：${raw.slice(0, 200)}`, 'parse');
  }
}

/**
 * An expired session very often shows up as a perfectly valid JSON body whose
 * `locate` is the login URL — not as an HTML login page. Treating that as data
 * is how a plugin ends up showing an empty list (or a bogus option) instead of
 * asking the user to sign in again, so it is caught before anything else.
 */
function looksLikeLoginRedirect(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) return false;
  const locate = record['locate'];
  return typeof locate === 'string' && /f=login/i.test(locate);
}

/** ZenTao wraps answers in a status envelope; unwrap it to the useful object. */
function unwrap(payload: unknown): unknown {
  // The envelope nests: {"status":"success","data":"{\"…\":…}"} — `data` is
  // often a JSON *string*, so each level is unwrapped and re-checked.
  let current: unknown = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (looksLikeLoginRedirect(current)) {
      throw new ZentaoError('禅道要求重新登录（token 已失效）', 'auth');
    }
    const record = asRecord(current);
    if (!record) return current;
    if (record.status === 'failed') {
      throw new ZentaoError(
        `禅道拒绝了本次请求：${String(record.reason ?? record.message ?? '未知原因')}`,
      );
    }
    if (record.status !== 'success' || !('data' in record)) return current;
    let inner = record.data;
    if (typeof inner === 'string') {
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

function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') return Object.values(value as Record<string, T>);
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#?\w+);/g, (match, name: string) => ENTITIES[name] ?? match);
}

/** Flattens a ZenTao HTML field (steps, comments) into readable plain text. */
function htmlToText(html: string): string {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|td)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalises the several shapes ZenTao uses for `id -> label` collections:
 * a dict of `id: name`, a dict of `id: {id, name}`, or an array of objects.
 */
function toOptions(
  container: unknown,
  take: (record: Record<string, unknown>, fallbackId: string) => { id: string; name: string },
): Array<{ id: string; name: string }> {
  if (Array.isArray(container)) {
    const out: Array<{ id: string; name: string }> = [];
    for (const entry of container) {
      const record = asRecord(entry);
      if (!record) continue;
      const option = take(record, '');
      if (option.id) out.push(option);
    }
    return out;
  }
  const record = asRecord(container);
  if (!record) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const [key, value] of Object.entries(record)) {
    const inner = asRecord(value);
    const option = inner
      ? take(inner, key)
      : { id: key, name: typeof value === 'string' ? value : key };
    if (option.id && option.id !== '0') out.push(option);
  }
  return out;
}

type SelectOption = { id: string; name: string; group: string };

/**
 * Reads one `<select name="…">` out of a rendered ZenTao form page, keeping the
 * `<optgroup>` a choice belongs to — ZenTao groups 迭代 by project that way,
 * and that group is the only thing telling two same-named sprints apart.
 */
function extractSelect(html: string, name: string): SelectOption[] {
  const selectRe = new RegExp(
    `<select[^>]*\\bname=["']?${name}\\[?\\]?["']?[^>]*>([\\s\\S]*?)<\\/select>`,
    'i',
  );
  const select = selectRe.exec(html);
  if (!select?.[1]) return [];
  const options: SelectOption[] = [];
  const tokenRe =
    /<optgroup[^>]*\blabel=["']([^"']*)["'][^>]*>|<option[^>]*\bvalue=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let group = '';
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(select[1])) !== null) {
    if (match[1] !== undefined) {
      group = decodeEntities(match[1]).trim();
      continue;
    }
    const id = decodeEntities(match[2] ?? '').trim();
    const label = decodeEntities((match[3] ?? '').replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (id && id !== '0') options.push({ id, name: label || id, group });
  }
  return options;
}

/**
 * ZenTao renders people as `Z:张长宏` — a pinyin initial, a colon and the real
 * name. Only the part after the colon is the name.
 */
function personName(label: string, fallback: string): string {
  const stripped = label.replace(/^\s*[A-Za-z]{1,3}\s*:\s*/, '').trim();
  return stripped || label || fallback;
}

function toBug(raw: Record<string, unknown>, base: string): Bug {
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
    url: `${base}/index.php?m=bug&f=view&bugID=${encodeURIComponent(id)}`,
  };
}

/* ------------------------------------------------------------------- client */

export type BugQuery = {
  product: string;
  /** Narrow to one 迭代. Applied locally: ZenTao ignores it upstream. */
  execution?: string;
  /** Narrow to one status. Applied last, so the other buckets stay countable. */
  status?: BugStatus | '';
  /** Narrow to one assignee ('仅看我的'). Applied locally. */
  assignedTo?: string;
};

export class Zentao {
  readonly base: string;
  private token: string;
  private readonly timeoutMs: number;

  constructor(base: string, token: string, timeoutMs: number = ZENTAO_TIMEOUT_MS) {
    this.base = normaliseBase(base);
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  get sessionToken(): string {
    return this.token;
  }

  set sessionToken(value: string) {
    this.token = value;
  }

  private headers(referer?: string): Record<string, string> {
    return {
      // ZenTao accepts the session id either way; sending both survives
      // instances whose WAF strips one of them.
      Cookie: `zentaosid=${this.token}`,
      Token: this.token,
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      // ZenTao drops $_POST unless Referer is same-origin.
      Referer: referer || `${this.base}/index.php`,
    };
  }

  /** A raw, unparsed call — used for HTML pages and for diagnostics. */
  async raw(query: string, form?: Form, referer?: string): Promise<string> {
    const url = `${this.base}/index.php?${query}`;
    const body = form === undefined ? undefined : encodeForm(form);
    const headers = this.headers(referer);
    if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ZentaoError(`无法连接 ${this.base}：${detail}`, 'network');
    }
    return await response.text();
  }

  /** Call, parse and unwrap in one step. */
  async call(query: string, form?: Form, referer?: string): Promise<unknown> {
    return unwrap(parseJson(await this.raw(query, form, referer)));
  }

  /**
   * The product list.
   *
   * `m=product&f=all` answers with two collections: `products`, a flat
   * `id -> name` lookup table that also carries long-dead ids (39 entries on a
   * real instance), and `productStats`, the products the product page actually
   * lists (8 on the same instance — exactly the payload's own `recTotal`).
   * Only the latter is a product *list*. Older ZenTao has no `productStats`,
   * so the lookup table stays as the fallback.
   */
  async products(): Promise<ProductOption[]> {
    const inner = await this.call('m=product&f=all&t=json');
    const record = asRecord(inner);
    const take = (entry: Record<string, unknown>, fallbackId: string) => ({
      id: text(entry.id ?? entry.value ?? fallbackId),
      name: text(entry.name ?? entry.title ?? entry.label ?? fallbackId),
    });

    const fromStats = toOptions(record?.['productStats'], take).filter(
      (option) => option.id && option.name,
    );
    if (fromStats.length) {
      return fromStats.map((option) => ({ id: option.id, name: option.name }));
    }

    return toOptions(record?.['products'] ?? inner, take)
      // ZenTao product ids are numeric; anything else is a payload key that
      // leaked through, not a product.
      .filter((option) => /^\d+$/.test(option.id))
      .map((option) => ({ id: option.id, name: option.name }));
  }

  async members(): Promise<MemberOption[]> {
    const inner = await this.call('m=company&f=browse&t=json');
    const container = asRecord(inner)?.['users'] ?? inner;
    const out: MemberOption[] = [];
    for (const entry of asList<Record<string, unknown>>(container)) {
      const record = asRecord(entry);
      if (!record) continue;
      const account = text(record.account);
      if (!account) continue;
      out.push({ id: text(record.id), account, realname: text(record.realname) });
    }
    return out;
  }

  /**
   * Everything that hangs off one product: its 迭代 and its members.
   *
   * Both come from the bug form, which is the one place ZenTao renders the
   * executions a bug of this product may belong to and the people who may be
   * assigned one. Neither is guessed, and both are scoped to the product
   * rather than to the whole company.
   */
  async productContext(productId: string): Promise<ProductContext> {
    const product = text(productId).trim();
    if (!product) return { executions: [], members: [] };
    const query = `m=bug&f=create&product=${encodeURIComponent(product)}`;
    const html = await this.raw(query, undefined, `${this.base}/index.php?${query}`);
    if (looksLikeLogin(html)) {
      throw new ZentaoError('禅道要求重新登录（token 已失效）', 'auth');
    }

    const executions: ExecutionOption[] = extractSelect(html, 'execution').map((option) => ({
      id: option.id,
      name: option.group ? `${option.group} / ${option.name}` : option.name,
    }));

    let members: MemberOption[] = extractSelect(html, 'assignedTo').map((option) => ({
      id: option.id,
      account: option.id,
      realname: personName(option.name, option.id),
    }));

    // A product with no team of its own still deserves a usable list.
    if (!members.length) members = await this.members();

    return { executions, members };
  }

  /**
   * One browse request.
   *
   * ZenTao only answers a real page when the request carries the whole
   * signature its own links use — `branch`, `browseType`, `param`, `orderBy`
   * and, crucially, the `recTotal` it reported last time. Drop any of those and
   * it answers an empty page instead of an error, which is how a plugin ends up
   * spinning forever on an empty list.
   */
  private browseQuery(product: string, pageID: number, recTotal: number): string {
    return new URLSearchParams({
      m: 'bug',
      f: 'browse',
      product,
      t: 'json',
      branch: '0',
      browseType: 'unclosed',
      param: '0',
      orderBy: 'id_desc',
      recTotal: String(recTotal),
      recPerPage: String(BROWSE_PAGE_SIZE),
      pageID: String(pageID),
    }).toString();
  }

  /**
   * Walks every page of one product's bugs.
   *
   * Plenty of deployments ignore `status`, `browseType`, `assignedTo`,
   * `executionID` and even `recPerPage`, so nothing can be filtered or paged
   * upstream: the whole set is pulled down once and narrowed in `bugs()`.
   */
  private async fetchAll(product: string): Promise<{ bugs: Bug[]; truncated: boolean }> {
    const bugs: Bug[] = [];
    const seen = new Set<string>();
    let recTotal = 0;

    for (let pageID = 1; pageID <= MAX_BROWSE_PAGES; pageID += 1) {
      const inner = await this.call(this.browseQuery(product, pageID, recTotal));
      const pager = asRecord(asRecord(inner)?.['pager']);
      const reported = Number(pager?.['recTotal'] ?? 0);
      if (Number.isFinite(reported) && reported > 0) recTotal = reported;

      const page = asList<Record<string, unknown>>(asRecord(inner)?.['bugs'] ?? inner)
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => toBug(entry, this.base))
        .filter((bug) => {
          if (!bug.id || seen.has(bug.id)) return false;
          seen.add(bug.id);
          return true;
        });

      bugs.push(...page);
      if (!page.length) break;

      const pageTotal = Number(pager?.['pageTotal'] ?? 0);
      if (Number.isFinite(pageTotal) && pageTotal > 0 && pageID >= pageTotal) break;
      if (recTotal && bugs.length >= recTotal) break;
    }

    return { bugs, truncated: recTotal > bugs.length };
  }

  /**
   * The bugs of one product, narrowed locally.
   *
   * `status` is applied last so a caller can ask for one bucket while the other
   * two remain countable — which is what the panel's tabs are.
   */
  async bugs(query: BugQuery): Promise<BugList> {
    const product = text(query.product).trim();
    if (!product) throw new ZentaoError('请先选择项目（产品）', 'config');

    const { bugs: all, truncated } = await this.fetchAll(product);

    // Only narrow on a field the instance actually populates, so an instance
    // that omits it degrades to the wider list instead of an empty one.
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

  async bug(id: string): Promise<BugDetail> {
    const bugId = text(id).trim();
    if (!bugId) throw new ZentaoError('缺少 bugID', 'config');
    const inner = await this.call(`m=bug&f=view&bugID=${encodeURIComponent(bugId)}&t=json`);
    const record = asRecord(asRecord(inner)?.['bug'] ?? inner);
    if (!record) throw new ZentaoError(`未找到 bug #${bugId}`, 'notfound');
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
      resolvedDate: text(record.resolvedDate),
    };
  }

  private bugReferer(bugId: string): string {
    return `${this.base}/index.php?m=bug&f=view&bugID=${encodeURIComponent(bugId)}`;
  }

  async resolve(
    id: string,
    comment: string,
    options: { resolution?: string; resolvedBuild?: string } = {},
  ): Promise<unknown> {
    const bugId = text(id).trim();
    if (!bugId) throw new ZentaoError('缺少 bugID', 'config');
    return this.call(
      `m=bug&f=resolve&bugID=${encodeURIComponent(bugId)}&t=json`,
      {
        uid: uid(),
        status: 'resolved',
        resolution: options.resolution || 'resolved',
        // ZenTao validates this against the product's builds; 'trunk' is the
        // conventional catch-all and is overridable in settings.
        resolvedBuild: options.resolvedBuild || 'trunk',
        resolvedDate: today(),
        comment: comment || '',
      },
      this.bugReferer(bugId),
    );
  }

  async close(id: string, comment: string): Promise<unknown> {
    const bugId = text(id).trim();
    if (!bugId) throw new ZentaoError('缺少 bugID', 'config');
    return this.call(
      `m=bug&f=close&bugID=${encodeURIComponent(bugId)}&t=json`,
      { uid: uid(), status: 'closed', comment: comment || '' },
      this.bugReferer(bugId),
    );
  }

  async activate(id: string, comment: string, assignedTo: string): Promise<unknown> {
    const bugId = text(id).trim();
    if (!bugId) throw new ZentaoError('缺少 bugID', 'config');
    // Activating reopens against the builds the bug was reported on.
    let openBuilds = ['trunk'];
    try {
      const detail = await this.bug(bugId);
      const split = detail.openedBuild
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (split.length) openBuilds = split;
    } catch {
      // Fall back to the conventional value.
    }
    return this.call(
      `m=bug&f=activate&bugID=${encodeURIComponent(bugId)}&t=json`,
      {
        uid: uid(),
        status: 'active',
        assignedTo: assignedTo || '',
        'openedBuild[]': openBuilds,
        comment: comment || '',
      },
      this.bugReferer(bugId),
    );
  }

  async profile(): Promise<{ id: string; account: string; realname: string } | null> {
    const inner = await this.call('m=user&f=profile&t=json');
    const record = asRecord(asRecord(inner)?.['user'] ?? inner);
    if (!record) return null;
    return {
      id: text(record.id),
      account: text(record.account),
      realname: text(record.realname),
    };
  }
}

/* --------------------------------------------------------------------- login */

export type LoginResult = { token: string; account: string; realname: string };

function collectCookies(response: Response, jar: Map<string, string>): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const lines: string[] = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [];
  if (!lines.length) {
    const single = response.headers.get('set-cookie');
    if (single) lines.push(single);
  }
  for (const line of lines) {
    // One header may carry several cookies; split before the next name=value.
    for (const part of line.split(/,(?=[^;=,\s]+=)/)) {
      const pair = part.split(';')[0] ?? '';
      const equals = pair.indexOf('=');
      if (equals <= 0) continue;
      jar.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
    }
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Signs in with an account and password, exactly the way ZenTao's own login
 * page does, and returns the resulting `zentaosid` — which is also the token
 * every later call carries.
 *
 * The password is never sent in clear: ZenTao submits
 * `md5(md5(password) + rand)` where `rand` comes from `refreshRandom`. Older
 * instances hand back an empty `rand`; there the correct form is a bare
 * `md5(password)` with no `verifyRand`, so both are supported.
 */
export async function login(
  base: string,
  account: string,
  password: string,
  timeoutMs: number = ZENTAO_TIMEOUT_MS,
): Promise<LoginResult> {
  const root = normaliseBase(base);
  if (!account.trim()) throw new ZentaoError('禅道账号为空', 'config');
  if (!password) throw new ZentaoError('禅道密码为空', 'config');

  const loginUrl = `${root}/index.php?m=user&f=login`;
  const jar = new Map<string, string>();

  const send = async (url: string, init: RequestInit): Promise<string> => {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ZentaoError(`无法连接 ${root}：${detail}`, 'network');
    }
    collectCookies(response, jar);
    return await response.text();
  };

  // 1) Take a session cookie.
  await send(loginUrl, { headers: { 'User-Agent': USER_AGENT } });

  // 2) Read the one-time random that salts the password.
  const rand = (
    await send(`${root}/index.php?m=user&f=refreshRandom`, {
      headers: { 'User-Agent': USER_AGENT, Referer: loginUrl },
    })
  ).trim();

  const form: Form = {
    account: account.trim(),
    password: rand ? md5(md5(password) + rand) : md5(password),
    passwordStrength: '1',
    referer: '/',
    keepLogin: '1',
    captcha: '',
  };
  if (rand) form.verifyRand = rand;

  // 3) Submit the login form.
  const body = await send(loginUrl, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
      Referer: loginUrl,
      Cookie: cookieHeader(jar),
    },
    body: encodeForm(form),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.replace(/^\uFEFF/, '').trim());
  } catch {
    throw new ZentaoError(`登录响应不是 JSON：${body.slice(0, 200)}`, 'parse');
  }
  const record = asRecord(parsed);
  if (record?.['result'] === 'fail') {
    throw new ZentaoError(
      `登录失败：${text(record['message']) || '账号或密码错误'}`,
      'auth',
    );
  }

  let token = jar.get('zentaosid') || '';

  // Some deployments answer the login POST with a JSON `locate` instead of a
  // redirect, which is where the new session cookie actually gets issued.
  if (!token && typeof record?.['locate'] === 'string') {
    const locate = record['locate'];
    if (locate.startsWith(root)) {
      await send(locate, {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: loginUrl,
          Cookie: cookieHeader(jar),
        },
      });
      token = jar.get('zentaosid') || '';
    }
  }

  if (!token) throw new ZentaoError('登录成功但没有拿到 zentaosid 会话', 'auth');

  // Confirm the session really works and learn the display name.
  let realname = '';
  try {
    const who = await new Zentao(root, token, timeoutMs).profile();
    realname = who?.realname ?? '';
  } catch {
    // Not fatal: the token is what matters.
  }

  return { token, account: account.trim(), realname };
}