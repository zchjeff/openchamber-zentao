import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  ROUTES,
  type BugList,
  type BugStatus,
  type ConfigView,
  type Envelope,
  type KeepAliveState,
  type MemberOption,
  type ProductContext,
  type ProductOption,
  type SessionView,
  type ZtErrorKind,
} from './protocol';
import {
  EMPTY_CONFIG,
  loadConfig,
  pickPatch,
  saveConfig,
  type StoredConfig,
} from './service/config';
import {
  Zentao,
  ZentaoError,
  login as zentaoLogin,
  normaliseBase,
} from './service/zentao';

/**
 * The local service behind the panel.
 *
 * The panel lives in a sandboxed iframe and cannot reach the network, so every
 * ZenTao call happens here: this process is the only thing that holds the
 * credentials and talks to the server.
 *
 * The host spawns it with OPENCHAMBER_SERVICE_PORT and
 * OPENCHAMBER_SERVICE_TOKEN; every request — /health included — must carry
 * `Authorization: Bearer <token>`.
 */

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? '');
const SERVICE_TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
const KEEP_ALIVE_MS = 10 * 60 * 1000;
const CACHE_MS = 30 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

if (!PORT) {
  console.error('[zentao] OPENCHAMBER_SERVICE_PORT is missing; refusing to start');
  process.exit(1);
}

/* ------------------------------------------------------------------ runtime */

class Runtime {
  config: StoredConfig = { ...EMPTY_CONFIG };
  keepAlive: KeepAliveState | null = null;

  private client: Zentao | null = null;
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  async init(): Promise<void> {
    this.config = await loadConfig();
    this.rebuild();
  }

  private rebuild(): void {
    this.client =
      this.config.base && this.config.token
        ? new Zentao(this.config.base, this.config.token)
        : null;
    this.cache.clear();
  }

  /** Drops cached lists — used after a write so the next read is fresh. */
  invalidate(): void {
    this.cache.clear();
  }

  private require(): Zentao {
    if (!this.client) {
      throw new ZentaoError(
        this.config.token ? '请先填写禅道地址' : '尚未登录禅道',
        'config',
      );
    }
    return this.client;
  }

  async save(patch: Partial<StoredConfig>): Promise<void> {
    this.config = { ...this.config, ...patch };
    await saveConfig(this.config);
    this.rebuild();
  }

  async signIn(base: string, account: string, password: string): Promise<void> {
    const result = await zentaoLogin(base, account, password);
    await this.save({
      base: normaliseBase(base),
      account: result.account,
      password,
      token: result.token,
      realname: result.realname,
    });
    this.keepAlive = { ok: true, at: Date.now(), message: '已连接禅道' };
  }

  /** Signs in again with the stored password, e.g. after a session expiry. */
  async relogin(): Promise<void> {
    const { base, account, password } = this.config;
    if (!base || !account || !password) {
      throw new ZentaoError('会话已失效，且没有保存密码，请重新登录', 'auth');
    }
    await this.signIn(base, account, password);
  }

  /**
   * Runs one ZenTao operation. A single auth failure is transparent: the
   * session is refreshed and the operation retried once, so a bug sitting on
   * an expired token never surfaces to the user.
   */
  async run<T>(operation: (client: Zentao) => Promise<T>): Promise<T> {
    try {
      return await operation(this.require());
    } catch (error) {
      if (error instanceof ZentaoError && error.kind === 'auth') {
        await this.relogin();
        this.keepAlive = { ok: true, at: Date.now(), message: '会话已过期，已自动重新登录' };
        return await operation(this.require());
      }
      throw error;
    }
  }

  async refresh<T>(key: string, force: boolean, produce: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await produce();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async keepAliveNow(): Promise<void> {
    if (!this.client) return;
    try {
      const profile = await this.run((client) => client.profile());
      const who = profile?.realname || profile?.account || '';
      this.keepAlive = {
        ok: true,
        at: Date.now(),
        message: who ? `禅道会话保活成功（${who}）` : '禅道会话保活成功',
      };
    } catch (error) {
      this.keepAlive = {
        ok: false,
        at: Date.now(),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

const runtime = new Runtime();

/* ---------------------------------------------------------------- transport */

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function ok<T>(data: T): Envelope<T> {
  return { ok: true, data };
}

function fail(res: ServerResponse, error: unknown): void {
  const kind: ZtErrorKind = error instanceof ZentaoError ? error.kind : 'unknown';
  const message = error instanceof Error ? error.message : String(error);
  send(res, kind === 'auth' ? 401 : kind === 'notfound' ? 404 : 500, {
    ok: false,
    error: message,
    kind,
  });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ZentaoError('请求体过大', 'unsupported');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new ZentaoError('请求体不是合法 JSON', 'unsupported');
  }
}

function configView(config: StoredConfig): ConfigView {
  return {
    base: config.base,
    account: config.account,
    realname: config.realname,
    product: config.product,
    execution: config.execution,
    memberAccount: config.memberAccount,
    resolvedBuild: config.resolvedBuild,
    hasPassword: Boolean(config.password),
    hasToken: Boolean(config.token),
  };
}

function asBugStatus(value: string): BugStatus | '' {
  return value === 'active' || value === 'resolved' || value === 'closed' ? value : '';
}

/* ------------------------------------------------------------------- routes */

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Record<string, unknown>,
): Promise<void> {
  const query = (key: string): string => url.searchParams.get(key) ?? '';
  const field = (key: string, fallback = ''): string => {
    const value = body[key];
    return typeof value === 'string' ? value : fallback;
  };
  const force = query('refresh') === '1';

  switch (url.pathname) {
    case ROUTES.health:
      send(res, 200, ok({ ready: true, hasSession: Boolean(runtime.config.token) }));
      return;

    case ROUTES.session: {
      const view: SessionView = {
        base: runtime.config.base,
        account: runtime.config.account,
        realname: runtime.config.realname,
        loggedIn: Boolean(runtime.config.base && runtime.config.token),
        keepAlive: runtime.keepAlive,
      };
      send(res, 200, ok(view));
      return;
    }

    case ROUTES.config:
      if (req.method === 'GET') {
        send(res, 200, ok(configView(runtime.config)));
        return;
      }
      await runtime.save(pickPatch(body));
      send(res, 200, ok(configView(runtime.config)));
      return;

    case ROUTES.login: {
      // A pasted token skips the password flow entirely.
      const token = field('token').trim();
      if (token) {
        const base = field('base', runtime.config.base);
        await runtime.save({ base: normaliseBase(base), token });
        const profile = await runtime.run((client) => client.profile());
        if (profile) {
          await runtime.save({
            account: profile.account,
            realname: profile.realname,
          });
        }
        send(res, 200, ok(configView(runtime.config)));
        return;
      }
      const base = field('base', runtime.config.base) || runtime.config.base;
      const account = field('account', runtime.config.account) || runtime.config.account;
      // An empty password means "reuse the saved one".
      const password = field('password') || runtime.config.password;
      await runtime.signIn(base, account, password);
      send(res, 200, ok(configView(runtime.config)));
      return;
    }

    case ROUTES.logout:
      await runtime.save({ token: '', realname: '', password: '' });
      runtime.keepAlive = null;
      send(res, 200, ok(configView(runtime.config)));
      return;

    case ROUTES.products: {
      const products = await runtime.run((client) => client.products());
      const data: ProductOption[] = products;
      send(res, 200, ok(data));
      return;
    }

    case ROUTES.executions: {
      const product = query('product') || field('product') || runtime.config.product;
      const context: ProductContext = await runtime.refresh(
        `context:${product}`,
        force,
        () => runtime.run((client) => client.productContext(product)),
      );
      send(res, 200, ok(context));
      return;
    }

    case ROUTES.members: {
      const members: MemberOption[] = await runtime.refresh('members', force, () =>
        runtime.run((client) => client.members()),
      );
      send(res, 200, ok(members));
      return;
    }

    case ROUTES.bugs: {
      const data: BugList = await runtime.run((client) =>
        client.bugs({
          product: query('product') || runtime.config.product,
          execution: query('execution'),
          status: asBugStatus(query('status')),
          assignedTo: query('assignedTo'),
        }),
      );
      send(res, 200, ok(data));
      return;
    }

    case ROUTES.bug: {
      const id = query('id') || field('id');
      const data = await runtime.run((client) => client.bug(id));
      send(res, 200, ok(data));
      return;
    }

    case ROUTES.resolve: {
      const id = field('id') || query('id');
      const data = await runtime.run((client) =>
        client.resolve(id, field('comment'), {
          resolution: field('resolution', 'resolved'),
          resolvedBuild: field('resolvedBuild', runtime.config.resolvedBuild),
        }),
      );
      runtime.invalidate();
      send(res, 200, ok({ result: 'ok', raw: data }));
      return;
    }

    case ROUTES.close: {
      const id = field('id') || query('id');
      const data = await runtime.run((client) => client.close(id, field('comment')));
      runtime.invalidate();
      send(res, 200, ok({ result: 'ok', raw: data }));
      return;
    }

    case ROUTES.activate: {
      const id = field('id') || query('id');
      const data = await runtime.run((client) =>
        client.activate(id, field('comment'), field('assignedTo')),
      );
      runtime.invalidate();
      send(res, 200, ok({ result: 'ok', raw: data }));
      return;
    }

    case ROUTES.keepalive:
      await runtime.keepAliveNow();
      send(res, 200, ok(runtime.keepAlive));
      return;

    case ROUTES.debug: {
      // Replays a raw ZenTao query so a deployment quirk can be inspected
      // from the panel without a second tooling setup.
      const rawQuery = query('query') || field('query');
      if (!rawQuery) throw new ZentaoError('缺少 query 参数', 'config');
      const text = await runtime.run((client) => client.raw(rawQuery));
      send(res, 200, ok({ query: rawQuery, body: text.slice(0, 20000) }));
      return;
    }

    default:
      send(res, 404, { ok: false, error: `未知路由 ${url.pathname}`, kind: 'notfound' });
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
      // The token is a shared secret with the host: without it nothing runs.
      send(res, 401, { ok: false, error: 'unauthorized', kind: 'auth' });
      return;
    }
    try {
      const body =
        req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
      await handle(req, res, url, body);
    } catch (error) {
      fail(res, error);
    }
  })();
});

await runtime.init();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[zentao] service ready on 127.0.0.1:${PORT}`);
});

// Keep the ZenTao session warm so the panel never shows a stale login.
const timer = setInterval(() => {
  void runtime.keepAliveNow();
}, KEEP_ALIVE_MS);
timer.unref?.();

// Populate the footer as soon as the service is up.
setTimeout(() => {
  void runtime.keepAliveNow();
}, 1500).unref?.();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref?.();
  });
}