/**
 * Shared vocabulary between the panel (sandboxed iframe) and the local
 * service. Both bundles import this file, so the wire shape can never drift.
 */

export type ZtErrorKind =
  | 'auth'
  | 'network'
  | 'parse'
  | 'config'
  | 'notfound'
  | 'unsupported'
  | 'unknown';

/** Every service route answers with this envelope. */
export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; kind: ZtErrorKind };

export type ProductOption = { id: string; name: string };
export type ExecutionOption = { id: string; name: string };
export type MemberOption = { id: string; account: string; realname: string };

/** Everything the panel needs once a product is chosen: its 迭代 and its members. */
export type ProductContext = {
  executions: ExecutionOption[];
  members: MemberOption[];
};

export type BugStatus = 'active' | 'resolved' | 'closed';

export type Bug = {
  id: string;
  title: string;
  status: string;
  type: string;
  pri: string;
  severity: string;
  assignedTo: string;
  openedBy: string;
  openedDate: string;
  execution: string;
  product: string;
  url: string;
};

export type BugDetail = Bug & {
  /** Steps with the HTML flattened to plain text, ready to paste into a prompt. */
  steps: string;
  module: string;
  project: string;
  os: string;
  browser: string;
  openedBuild: string;
  resolution: string;
  resolvedBy: string;
  resolvedDate: string;
};

export type BugList = {
  /**
   * The whole matching set. ZenTao ignores the filter parameters on plenty of
   * deployments, so the service walks every page and hands the lot over; the
   * panel does the filtering, the counting and the paging itself.
   */
  bugs: Bug[];
  total: number;
  /** ZenTao had more bugs than the service was willing to fetch. */
  truncated: boolean;
};

/** The persisted settings, minus anything secret. */
export type ConfigView = {
  base: string;
  account: string;
  realname: string;
  product: string;
  execution: string;
  memberAccount: string;
  resolvedBuild: string;
  hasPassword: boolean;
  hasToken: boolean;
};

export type KeepAliveState = { ok: boolean; at: number; message: string };

export type SessionView = {
  base: string;
  account: string;
  realname: string;
  loggedIn: boolean;
  keepAlive: KeepAliveState | null;
};

export const ROUTES = {
  health: '/health',
  config: '/api/config',
  session: '/api/session',
  login: '/api/login',
  logout: '/api/logout',
  products: '/api/products',
  executions: '/api/executions',
  members: '/api/members',
  bugs: '/api/bugs',
  bug: '/api/bug',
  resolve: '/api/bug/resolve',
  close: '/api/bug/close',
  activate: '/api/bug/activate',
  keepalive: '/api/keepalive',
  debug: '/api/debug',
} as const;

/** Keeps a prompt inside the host's 16000-character composer limit. */
export const PROMPT_MAX = 16000;

export const STATUS_LABELS: Record<string, string> = {
  active: '激活',
  resolved: '已解决',
  closed: '已关闭',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status ?? '未知';
}

/** Clips a string to `max` characters, marking the cut. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 20))}\n…（内容过长已截断）`;
}