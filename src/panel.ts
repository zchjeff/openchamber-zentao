import {
  connectHost,
  HostRequestError,
  isGuestSessionItem,
  type GuestSessionItem,
  type HostReadyContext,
} from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountCheckbox,
  mountEmpty,
  mountSelect,
  mountSeparator,
  mountSpinner,
  mountSwitch,
  mountText,
  mountTextField,
  type BadgeHandle,
  type ButtonProps,
  type CheckboxHandle,
  type SelectHandle,
  type SelectOption,
} from '@openchamber/sdk/ui';
import {
  PROMPT_MAX,
  ROUTES,
  clip,
  statusLabel,
  type Bug,
  type BugDetail,
  type BugList,
  type BugStatus,
  type ConfigView,
  type Envelope,
  type ExecutionOption,
  type MemberOption,
  type ProductContext,
  type ProductOption,
  type SessionView,
} from './protocol';

/**
 * The panel. It draws the UI and owns no credentials: everything that touches
 * ZenTao goes through `host.serviceRequest` to the local service, which is the
 * only place a session token ever exists.
 */

const host = connectHost();
const rootElement = document.querySelector('#root');
if (!rootElement) throw new Error('panel is missing #root');
const root = rootElement as HTMLElement;

type PendingKind = 'resolve' | 'close';
type Pending = { kind: PendingKind; bug: BugDetail; comment: string; auto?: boolean };
type Banner = { tone: 'info' | 'success' | 'warning' | 'error'; title: string; body?: string };

const state = {
  cfg: null as ConfigView | null,
  products: [] as ProductOption[],
  executions: [] as ExecutionOption[],
  members: [] as MemberOption[],
  /** The status buckets currently ticked; empty means "no status filter". */
  statuses: ['active'] as BugStatus[],
  mineOnly: false,
  /** Every bug the service returned for the current product. */
  all: [] as Bug[],
  /** The page of `all` that survives the current filters. */
  bugs: [] as Bug[],
  /** The bug opened in the preview modal; null when the modal is closed. */
  modal: null as BugDetail | null,
  page: 1,
  pageSize: 20,
  total: 0,
  truncated: false,
  counts: { active: 0, resolved: 0, closed: 0 } as Record<BugStatus, number>,
  selected: '',
  pending: null as Pending | null,
  /** When true, AI 修复 sends its prompt in the new session instead of drafting it. */
  directSend: false,
  loading: false,
  busy: '',
  banner: null as Banner | null,
  /** Mirrors the connection inputs; the kit fields report every keystroke. */
  draft: { base: '', account: '', password: '', token: '' },
};

/* ---------------------------------------------------------------- utilities */

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toneFor(status: string): 'warning' | 'success' | 'neutral' | 'info' {
  if (status === 'resolved') return 'success';
  if (status === 'closed') return 'neutral';
  if (status === 'active') return 'warning';
  return 'info';
}

function nameOf(account: string): string {
  if (!account) return '未指派';
  const member = state.members.find((entry) => entry.account === account);
  return member?.realname ? `${member.realname}（${account}）` : account;
}

/** The account the panel is logged in as — what 「仅看我的」 narrows to. */
function loggedInAccount(): string {
  return state.cfg?.account ?? '';
}

/** A person's display name for the 成员 filter; falls back to the account. */
function memberLabel(account: string): string {
  const member = state.members.find((entry) => entry.account === account);
  return member?.realname || account;
}

/** Sentinel id for the 成员 filter's 「全部」 row (no member narrowing). */
const ALL_MEMBERS = '*';

/**
 * The assignees that actually appear among the bugs of the current 迭代 — the
 * 成员 filter is derived from the bug list, not the product's whole team, so
 * every option narrows to something. Falls back to the product team when the
 * bug payload carries no assignees.
 */
function scopedAssignees(): Set<string> {
  const execution = state.cfg?.execution ?? '';
  const scope =
    execution && state.all.some((bug) => bug.execution)
      ? state.all.filter((bug) => bug.execution === execution)
      : state.all;
  const accounts = new Set<string>();
  for (const bug of scope) if (bug.assignedTo) accounts.add(bug.assignedTo);
  if (!accounts.size) for (const member of state.members) accounts.add(member.account);
  return accounts;
}

function describeError(error: unknown): string {
  if (error instanceof HostRequestError) {
    switch (error.code) {
      case 'HOST_UNAVAILABLE':
        return '这个面板需要在 OpenChamber 里打开';
      case 'NO_SERVICE':
        return '本地服务未启动或未授权：请在 设置 → 扩展 里重新授权本扩展';
      case 'SERVICE_FAILED':
        return '本地服务启动失败，请在 OpenChamber 日志里查看原因';
      case 'NO_SESSION':
        return '当前没有打开的会话，请先新建一个会话';
      case 'SESSION_BUSY':
        return '当前会话正在忙，稍后再试';
      case 'NOT_GRANTED':
        return '扩展缺少所需权限，请在 设置 → 扩展 里重新授权';
      case 'HOST_TIMEOUT':
        return '请求超时：禅道响应太慢或网络不通';
      case 'DISABLED':
        return '扩展已被暂停，请在 设置 → 扩展 里恢复';
      default:
        return `${error.code}：${error.message}`;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Every service call goes through here; the envelope is unwrapped once. */
async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const result = await host.serviceRequest({
    method,
    path,
    ...(options.query ? { query: options.query } : {}),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    parsed = null;
  }
  const envelope = parsed as Envelope<T> | null;
  if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
    throw new Error(`本地服务返回了无法解析的响应（HTTP ${result.status}）`);
  }
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data;
}

function toast(kind: 'info' | 'success' | 'error', message: string): void {
  void host.toast({ kind, message }).catch(() => undefined);
}

/* ----------------------------------------------------------------- handles */

/** Controls that live as long as the panel does. */
const staticHandles: Array<{ dispose: () => void }> = [];
/** Controls inside re-rendered regions; released on every repaint. */
let renderHandles: Array<{ dispose: () => void }> = [];

function keep(handle: { dispose: () => void }): void {
  staticHandles.push(handle);
}

function scratch(handle: { dispose: () => void }): void {
  renderHandles.push(handle);
}

function buttonIn(props: ButtonProps): HTMLElement {
  const element = h('span', 'zt-btn');
  scratch(mountButton(element, props));
  return element;
}

let productSelect: SelectHandle | null = null;
let execSelect: SelectHandle | null = null;
let memberSelect: SelectHandle | null = null;
let loginButton: ReturnType<typeof mountButton> | null = null;
let sessionBadge: BadgeHandle | null = null;
const statusBoxes: Partial<Record<BugStatus, CheckboxHandle>> = {};
let mineCheckbox: CheckboxHandle | null = null;
let directSendSwitch: CheckboxHandle | null = null;

let connectionHost: HTMLElement;
let connectionBody: HTMLElement;
let bannerHost: HTMLElement;
let filtersHost: HTMLElement;
let toolbarHost: HTMLElement;
let listHost: HTMLElement;
let pagerHost: HTMLElement;
let footerHost: HTMLElement;
let modalHost: HTMLElement;

/* ------------------------------------------------------------------ build */

let built = false;

host.onReady((ready) => {
  // Colours must follow every theme switch...
  applyHostReady(ready, document.documentElement);
  // A background frame exists only to run a session action; it draws nothing.
  if (ready.surface === 'background') return;
  // ...but the UI itself is built exactly once.
  if (!built) {
    built = true;
    mountUi(ready);
    return;
  }
  // A later snapshot can carry a freshly invoked action.
  if (ready.item && isGuestSessionItem(ready.item)) void handleWritebackItem(ready.item);
});

function mountUi(ready: HostReadyContext): void {
  const shell = h('div', 'zt');
  bannerHost = h('div', 'zt-banner');
  connectionHost = h('section', 'zt-section');
  filtersHost = h('section', 'zt-section');
  toolbarHost = h('div', 'zt-toolbar');
  listHost = h('section', 'zt-list');
  pagerHost = h('div', 'zt-pager');
  footerHost = h('div', 'zt-foot');
  modalHost = h('div', 'zt-modal');
  shell.append(
    bannerHost,
    connectionHost,
    filtersHost,
    toolbarHost,
    listHost,
    pagerHost,
    footerHost,
  );
  // The modal is drawn over the panel; it lives outside `#root`'s scroll flow.
  document.body.append(modalHost);
  root.append(shell);

  // Escape closes the preview from anywhere in the panel.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.modal) {
      event.preventDefault();
      closePreview();
    }
  });

  buildConnection();
  buildFilters();
  buildToolbar();
  render();
  paintFooter('正在连接本地服务…');

  void applyReadyItem(ready.item);
}

function buildConnection(): void {
  const head = h('div', 'zt-head');
  const badgeHost = h('span');
  sessionBadge = mountBadge(badgeHost, { label: '未连接', tone: 'neutral' });
  keep(sessionBadge);

  const toggleHost = h('span', 'zt-btn');
  keep(
    mountButton(toggleHost, {
      label: '设置',
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        connectionBody.hidden = !connectionBody.hidden;
      },
    }),
  );
  head.append(h('span', 'zt-title', '连接禅道'), badgeHost, h('span', 'zt-spacer'), toggleHost);

  connectionBody = h('div', 'zt-body');

  const baseHost = h('div', 'zt-line');
  keep(
    mountTextField(baseHost, {
      label: '禅道地址',
      value: '',
      placeholder: 'https://zentao.example.com',
      onChange: (value) => {
        state.draft.base = value;
      },
    }),
  );

  const creds = h('div', 'zt-line zt-split');
  const accountHost = h('div');
  keep(
    mountTextField(accountHost, {
      label: '账号',
      value: '',
      placeholder: '禅道登录账号',
      onChange: (value) => {
        state.draft.account = value;
      },
    }),
  );
  const passwordHost = h('div');
  keep(
    mountTextField(passwordHost, {
      label: '密码',
      value: '',
      password: true,
      placeholder: '留空则沿用已保存的密码',
      onChange: (value) => {
        state.draft.password = value;
      },
    }),
  );
  creds.append(accountHost, passwordHost);

  const tokenHost = h('div', 'zt-line');
  keep(
    mountTextField(tokenHost, {
      label: '或用已有的 token（可留空）',
      value: '',
      mono: true,
      placeholder: '粘贴禅道会话 zentaosid',
      helper: '留空则用账号密码登录；填写后直接用该 token 连接',
      onChange: (value) => {
        state.draft.token = value;
      },
    }),
  );

  const actions = h('div', 'zt-actions');
  const loginHost = h('span', 'zt-btn');
  loginButton = mountButton(loginHost, {
    label: '连接',
    variant: 'default',
    onClick: () => void doLogin(),
  });
  keep(loginButton);

  const logoutHost = h('span', 'zt-btn');
  keep(
    mountButton(logoutHost, {
      label: '退出登录',
      variant: 'ghost',
      onClick: () => void doLogout(),
    }),
  );
  actions.append(loginHost, logoutHost);

  connectionBody.append(baseHost, creds, tokenHost, actions);
  connectionHost.append(head, connectionBody);
}

function refreshButton(onClick: () => void): HTMLElement {
  const element = h('span', 'zt-btn zt-btn-tail');
  keep(mountButton(element, { label: '刷新', variant: 'outline', size: 'sm', onClick }));
  return element;
}

function buildFilters(): void {
  const separatorHost = h('div');
  keep(mountSeparator(separatorHost, { label: '筛选' }));
  filtersHost.append(separatorHost);

  const productLine = h('div', 'zt-line zt-with-button');
  const productHost = h('div', 'zt-grow');
  productSelect = mountSelect(productHost, {
    label: '项目（产品）',
    value: null,
    options: [],
    searchable: true,
    placeholder: '选择项目',
    onChange: (id) => void chooseProduct(id),
  });
  keep(productSelect);
  productLine.append(productHost, refreshButton(() => void loadProducts()));

  const execLine = h('div', 'zt-line zt-with-button');
  const execHost = h('div', 'zt-grow');
  execSelect = mountSelect(execHost, {
    label: '迭代',
    value: null,
    options: [],
    searchable: true,
    placeholder: '选择迭代',
    onChange: (id) => void chooseExecution(id),
  });
  keep(execSelect);
  execLine.append(execHost, refreshButton(() => void loadProductContext(true)));

  const memberLine = h('div', 'zt-line zt-with-button');
  const memberHost = h('div', 'zt-grow');
  memberSelect = mountSelect(memberHost, {
    label: '成员',
    value: null,
    options: [],
    searchable: true,
    placeholder: '选择成员',
    onChange: (id) => void chooseMember(id),
  });
  keep(memberSelect);
  memberLine.append(memberHost, refreshButton(() => void loadProductContext(true)));

  const classLine = h('div', 'zt-line zt-class');
  const mineHost = h('div');
  mineCheckbox = mountCheckbox(mineHost, {
    label: '仅看我的',
    checked: false,
    onChange: (checked) => {
      state.mineOnly = checked;
      mineCheckbox?.update({ checked });
      repaint();
    },
  });
  keep(mineCheckbox);

  const statusHost = h('div', 'zt-grow zt-status');
  for (const { id, label } of STATUS_FILTERS) {
    const boxHost = h('div');
    const handle = mountCheckbox(boxHost, {
      label: `${label}（${state.counts[id]}）`,
      checked: state.statuses.includes(id),
      onChange: (checked) => {
        const next = new Set(state.statuses);
        if (checked) next.add(id);
        else next.delete(id);
        state.statuses = [...next];
        repaint();
      },
    });
    statusBoxes[id] = handle;
    keep(handle);
    statusHost.append(boxHost);
  }
  classLine.append(mineHost, statusHost);

  filtersHost.append(productLine, execLine, memberLine, classLine);
}

function buildToolbar(): void {
  // The toolbar is built once and never re-rendered, so its button must live
  // with the panel: `scratch` would hand it to the next `render()` to dispose,
  // which removes it from the DOM before it is ever seen.
  const refreshHost = h('span', 'zt-btn zt-refresh');
  keep(
    mountButton(refreshHost, {
      label: '刷新列表',
      variant: 'default',
      size: 'sm',
      onClick: () => void loadBugs(true),
    }),
  );

  const previewHost = h('div', 'zt-grow');
  directSendSwitch = mountSwitch(previewHost, {
    label: '新会话里直接发送',
    checked: false,
    description: '关闭时，AI 修复新建草稿会话并把提示词填进输入框；打开则在新会话里直接发送',
    onChange: (checked) => {
      state.directSend = checked;
      directSendSwitch?.update({ checked });
    },
  });
  keep(directSendSwitch);

  toolbarHost.append(refreshHost, previewHost);
}

const STATUS_FILTERS: Array<{ id: BugStatus; label: string }> = [
  { id: 'active', label: '未解决' },
  { id: 'resolved', label: '已解决' },
  { id: 'closed', label: '已关闭' },
];

/** Repaints the status checkboxes so their counts and ticks stay current. */
function updateStatusBoxes(): void {
  for (const { id, label } of STATUS_FILTERS) {
    statusBoxes[id]?.update({
      label: `${label}（${state.counts[id]}）`,
      checked: state.statuses.includes(id),
    });
  }
}

/**
 * Rebuilds the 成员 filter from the current 迭代's assignees, with 「全部」 on
 * top. It only ever offers people the visible bug set can actually be narrowed
 * by, so no option leads to an empty list.
 */
function updateMemberOptions(accounts: Set<string> = scopedAssignees()): void {
  if (!state.cfg?.product) {
    memberSelect?.update({ options: [], value: null });
    return;
  }
  const options: SelectOption[] = [{ id: ALL_MEMBERS, label: '全部', hint: '不限成员' }];
  for (const account of [...accounts].sort((a, b) =>
    memberLabel(a).localeCompare(memberLabel(b), 'zh'),
  )) {
    options.push({ id: account, label: memberLabel(account), hint: account });
  }
  const current = state.cfg?.memberAccount ?? '';
  memberSelect?.update({
    options,
    value: current && accounts.has(current) ? current : ALL_MEMBERS,
  });
}

/**
 * ZenTao ignores the filter parameters on plenty of deployments, so the whole
 * product's bugs arrive at once and every narrowing happens here instead of on
 * a round trip. That is also what makes the filters feel instant.
 *
 * Order matters: 迭代 and 成员 narrow the set, the checkboxes' counts report
 * what those two left behind, and the checkboxes decide which statuses show.
 */
function applyView(resetPage = true): void {
  if (resetPage) state.page = 1;

  const execution = state.cfg?.execution ?? '';
  const members = scopedAssignees();
  const member = state.cfg?.memberAccount ?? '';
  const mine = state.mineOnly ? loggedInAccount() : '';
  let matched = state.all;
  if (execution && state.all.some((bug) => bug.execution)) {
    matched = matched.filter((bug) => bug.execution === execution);
  }
  if (member && members.has(member)) {
    matched = matched.filter((bug) => bug.assignedTo === member);
  }
  if (mine && state.all.some((bug) => bug.assignedTo)) {
    matched = matched.filter((bug) => bug.assignedTo === mine);
  }

  const counts = { active: 0, resolved: 0, closed: 0 } as Record<BugStatus, number>;
  for (const bug of matched) {
    if (bug.status === 'active' || bug.status === 'resolved' || bug.status === 'closed') {
      counts[bug.status] += 1;
    }
  }
  state.counts = counts;

  // No box ticked means "no status filter", so the list never empties by surprise.
  const found = state.statuses.length
    ? matched.filter((bug) => !bug.status || state.statuses.includes(bug.status as BugStatus))
    : matched;
  state.total = found.length;
  const pageCount = Math.max(1, Math.ceil(found.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), pageCount);
  const start = (state.page - 1) * state.pageSize;
  state.bugs = found.slice(start, start + state.pageSize);

  updateStatusBoxes();
  updateMemberOptions(members);
}

/** Re-derives the visible page after a filter change, then repaints. */
function repaint(resetPage = true): void {
  applyView(resetPage);
  render();
}

/* -------------------------------------------------------------- rendering */

/** Repaints every region that depends on fetched data, in one pass. */
function render(): void {
  for (const handle of renderHandles) handle.dispose();
  renderHandles = [];
  listHost.replaceChildren();
  pagerHost.replaceChildren();

  renderBanner();
  renderList();
  renderPager();
  renderModal();
}

function renderBanner(): void {
  bannerHost.replaceChildren();
  const banner = state.banner;
  if (!banner) return;
  const element = h('div');
  mountBanner(element, { tone: banner.tone, title: banner.title, body: banner.body });
  bannerHost.append(element);
}

function renderList(): void {
  if (state.loading && state.bugs.length === 0) {
    const element = h('div', 'zt-pad');
    mountSpinner(element, { label: '正在读取 bug 列表…' });
    listHost.append(element);
    return;
  }

  // The confirmation card always sits above the rows it acts on — and it stays
  // visible even before a product is chosen, so a session-action writeback is
  // never hidden by the empty state.
  if (state.pending) listHost.append(buildConfirm());

  if (!state.cfg?.product) {
    const element = h('div');
    mountEmpty(element, {
      title: '先连接禅道',
      body: '在「连接禅道」里填地址、账号和密码，然后选择项目。',
    });
    listHost.append(element);
    return;
  }

  if (state.truncated) {
    const element = h('div');
    mountBanner(element, {
      tone: 'warning',
      title: '只读取了最近的一批 bug',
      body: '这台禅道的记录比本次读取的更多，列表只覆盖了最近的部分。',
    });
    listHost.append(element);
  }

  if (state.bugs.length === 0) {
    const element = h('div');
    mountEmpty(element, {
      title: '没有符合条件的 bug',
      body: state.mineOnly
        ? '试试取消「仅看我的」、换一个成员，或勾选其它状态。'
        : '试试勾选其它状态，或刷新列表。',
    });
    listHost.append(element);
    return;
  }

  for (const bug of state.bugs) listHost.append(buildBugRow(bug));
}

function buildBugRow(bug: Bug): HTMLElement {
  const row = h('div', 'zt-bug');
  if (state.selected === bug.id) row.classList.add('is-selected');

  const head = h('div', 'zt-bug-head');
  const badgeHost = h('span');
  scratch(mountBadge(badgeHost, { label: statusLabel(bug.status), tone: toneFor(bug.status) }));
  head.append(
    h('span', 'zt-bug-id', `#${bug.id}`),
    badgeHost,
    h('span', 'zt-muted', `指派给 ${nameOf(bug.assignedTo)}`),
    h('span', 'zt-spacer'),
    h('span', 'zt-meta', (bug.openedDate || '').slice(0, 10)),
  );

  const actions = h('div', 'zt-actions');
  actions.append(
    buttonIn({
      label: '预览',
      variant: 'outline',
      size: 'xs',
      onClick: () => void openPreview(bug),
    }),
    buttonIn({
      label: 'AI 修复',
      variant: 'default',
      size: 'xs',
      onClick: () => void aiFix(bug),
    }),
    buttonIn({
      label: '解决',
      variant: 'secondary',
      size: 'xs',
      onClick: () => void openConfirm('resolve', bug),
    }),
    buttonIn({
      label: '关闭',
      variant: 'outline',
      size: 'xs',
      onClick: () => void openConfirm('close', bug),
    }),
    buttonIn({
      label: '禅道',
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        void host.openUrl(bug.url).catch(() => undefined);
      },
    }),
  );

  row.append(head, h('div', 'zt-bug-title', bug.title), actions);
  return row;
}

/** Draws the preview dialog for `state.modal`, if one is open. */
function renderModal(): void {
  modalHost.replaceChildren();
  const detail = state.modal;
  if (!detail) return;

  const backdrop = h('div', 'zt-modal-backdrop');
  // Clicking the dimmed area — but not the card — dismisses the dialog.
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closePreview();
  });

  const card = h('div', 'zt-modal-card');

  const badgeHost = h('span');
  scratch(
    mountBadge(badgeHost, { label: statusLabel(detail.status), tone: toneFor(detail.status) }),
  );
  const closeHost = h('span', 'zt-btn');
  scratch(
    mountButton(closeHost, {
      label: '关闭',
      variant: 'ghost',
      size: 'sm',
      onClick: () => closePreview(),
    }),
  );

  const head = h('div', 'zt-modal-head');
  head.append(
    h('span', 'zt-bug-id', `#${detail.id}`),
    badgeHost,
    h('span', 'zt-spacer'),
    closeHost,
  );

  card.append(head, h('div', 'zt-modal-title', detail.title), buildDetailBody(detail));
  backdrop.append(card);
  modalHost.append(backdrop);

  // Put focus on 关闭 so Escape / Enter act on the dialog immediately.
  (card.querySelector('button') as HTMLButtonElement | null)?.focus();
}

/** The facts, steps and actions shared by the preview dialog. */
function buildDetailBody(detail: BugDetail): HTMLElement {
  const box = h('div', 'zt-modal-body');

  const facts: Array<[string, string]> = [
    ['类型', detail.type],
    ['优先级', detail.pri],
    ['严重程度', detail.severity],
    ['模块', detail.module],
    ['平台', detail.os],
    ['浏览器', detail.browser],
    ['报告人', detail.openedBy],
    ['报告时间', detail.openedDate],
    ['影响版本', detail.openedBuild],
    ['解决方案', detail.resolution],
  ];
  const grid = h('div', 'zt-facts');
  for (const [label, value] of facts) {
    if (!value) continue;
    grid.append(h('span', 'zt-fact-k', label), h('span', 'zt-fact-v', value));
  }
  box.append(grid);

  if (detail.steps) {
    const stepsHost = h('div', 'zt-steps');
    scratch(
      mountText(stepsHost, {
        text: detail.steps,
        onOpenUrl: (url) => {
          void host.openUrl(url).catch(() => undefined);
        },
      }),
    );
    box.append(h('div', 'zt-label', '重现步骤'), stepsHost);
  }

  const actions = h('div', 'zt-actions');
  actions.append(
    buttonIn({
      label: '在禅道打开',
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        void host.openUrl(detail.url).catch(() => undefined);
      },
    }),
    buttonIn({
      label: '复制修复提示词',
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        void host.writeClipboard(promptFor(detail)).then(
          () => toast('success', '修复提示词已复制'),
          () => toast('error', '复制失败'),
        );
      },
    }),
  );
  box.append(actions);
  return box;
}

function buildConfirm(): HTMLElement {
  const pending = state.pending;
  const box = h('div', 'zt-confirm');
  if (!pending) return box;

  box.append(
    h(
      'div',
      'zt-confirm-title',
      `${
        pending.kind === 'resolve' ? (pending.auto ? '回写禅道并解决' : '确认解决') : '确认关闭'
      } #${pending.bug.id}`,
    ),
    h('div', 'zt-muted', pending.bug.title),
    h('pre', 'zt-pre', dryRunPreview(pending)),
  );

  const commentHost = h('div');
  scratch(
    mountTextField(commentHost, {
      label: '处理备注（作为评论写进禅道）',
      value: pending.comment,
      multiline: true,
      rows: 4,
      placeholder: '【根因】…\n【修复内容】…\n【修复版本】…',
      onChange: (value) => {
        pending.comment = value;
      },
    }),
  );
  box.append(commentHost);

  const actions = h('div', 'zt-actions');
  actions.append(
    buttonIn({
      label: pending.kind === 'resolve' ? '确认解决' : '确认关闭',
      variant: 'default',
      size: 'sm',
      onClick: () => void commitPending(pending),
    }),
    buttonIn({
      label: '取消',
      variant: 'ghost',
      size: 'sm',
      onClick: () => {
        state.pending = null;
        render();
      },
    }),
  );
  box.append(actions);
  return box;
}

/** Shows the exact request that is about to be sent — nothing hidden. */
function dryRunPreview(pending: Pending): string {
  const bugID = pending.bug.id;
  const comment = pending.comment ? '（见下方输入框）' : '空';
  if (pending.kind === 'resolve') {
    return [
      `POST /index.php?m=bug&f=resolve&bugID=${bugID}&t=json`,
      'Accept: application/json',
      'Referer: …m=bug&f=view&bugID=' + bugID,
      '',
      'status        = resolved',
      'resolution    = resolved',
      `resolvedBuild = ${state.cfg?.resolvedBuild || 'trunk'}`,
      `resolvedDate  = ${new Date().toISOString().slice(0, 10)}`,
      `comment       = ${comment}`,
    ].join('\n');
  }
  return [
    `POST /index.php?m=bug&f=close&bugID=${bugID}&t=json`,
    'Accept: application/json',
    'Referer: …m=bug&f=view&bugID=' + bugID,
    '',
    'status  = closed',
    `comment = ${comment}`,
  ].join('\n');
}

function renderPager(): void {
  if (!state.cfg?.product || state.total === 0) return;
  const pageCount = Math.max(1, Math.ceil(state.total / state.pageSize));

  pagerHost.append(
    h('span', 'zt-muted', `共 ${state.total} 条`),
    h('span', 'zt-spacer'),
    h('span', 'zt-muted', `${state.page} / ${pageCount}`),
    buttonIn({
      label: '上一页',
      variant: 'outline',
      size: 'xs',
      disabled: state.page <= 1,
      onClick: () => {
        state.page -= 1;
        repaint(false);
      },
    }),
    buttonIn({
      label: '下一页',
      variant: 'outline',
      size: 'xs',
      disabled: state.page >= pageCount,
      onClick: () => {
        state.page += 1;
        repaint(false);
      },
    }),
  );
}

function paintFooter(text: string): void {
  footerHost.textContent = text ? `状态：${text}` : '';
}

function renderSessionBadge(): void {
  const view = state.cfg;
  if (!view?.base || !view.hasToken) {
    sessionBadge?.update({ label: '未连接', tone: 'neutral' });
    return;
  }
  sessionBadge?.update({
    label: `已登录：${view.realname || view.account || '已连接'}`,
    tone: 'success',
  });
}

function setBusy(busy: string): void {
  state.busy = busy;
  loginButton?.update({ loading: busy === 'login', disabled: busy === 'login' });
}

/* ------------------------------------------------------------------ flow */

async function boot(focusBugId: string): Promise<void> {
  try {
    const config = await api<ConfigView>('GET', ROUTES.config);
    state.cfg = config;
    applyConfigToForm(config);
    renderSessionBadge();
    paintFooter('本地服务已就绪');

    if (config.base && config.hasToken) {
      connectionBody.hidden = true;
      // The member dropdown starts on the logged-in account, but the list is
      // not narrowed until the user asks for it.
      state.mineOnly = false;
      mineCheckbox?.update({ checked: false });
      await loadProducts();
      if (config.product) await Promise.all([loadProductContext(), loadBugs()]);
    } else {
      connectionBody.hidden = false;
      render();
    }

    if (focusBugId) void focusBug(focusBugId);
    void refreshSession();
    void refreshBadge();
  } catch (error) {
    state.banner = { tone: 'error', title: '无法连接本地服务', body: describeError(error) };
    render();
    paintFooter('本地服务不可用');
  }
}

function applyConfigToForm(config: ConfigView): void {
  state.draft.base = config.base;
  state.draft.account = config.account;
  state.draft.password = '';
  state.draft.token = '';
}

async function doLogin(): Promise<void> {
  setBusy('login');
  state.banner = null;
  try {
    const config = await api<ConfigView>('POST', ROUTES.login, {
      body: {
        base: state.draft.base,
        account: state.draft.account,
        password: state.draft.password,
        token: state.draft.token,
      },
    });
    state.cfg = config;
    state.draft.password = '';
    state.draft.token = '';
    renderSessionBadge();
    toast('success', '已连接禅道');
    await loadProducts();
    if (state.cfg?.product) await Promise.all([loadProductContext(), loadBugs()]);
    render();
  } catch (error) {
    state.banner = { tone: 'error', title: '连接失败', body: describeError(error) };
    render();
    toast('error', describeError(error));
  } finally {
    setBusy('');
  }
}

async function doLogout(): Promise<void> {
  try {
    const config = await api<ConfigView>('POST', ROUTES.logout);
    state.cfg = config;
    state.products = [];
    state.executions = [];
    state.members = [];
    state.all = [];
    state.bugs = [];
    state.total = 0;
    state.counts = { active: 0, resolved: 0, closed: 0 };
    state.selected = '';
    state.modal = null;
    state.pending = null;
    state.draft.password = '';
    state.draft.token = '';
    applyConfigToForm(config);
    productSelect?.update({ value: null, options: [] });
    execSelect?.update({ value: null, options: [] });
    memberSelect?.update({ value: null, options: [] });
    state.statuses = ['active'];
    updateStatusBoxes();
    renderSessionBadge();
    connectionBody.hidden = false;
    void host.setBadge(null).catch(() => undefined);
    render();
  } catch (error) {
    state.banner = { tone: 'error', title: '退出失败', body: describeError(error) };
    render();
  }
}

async function saveConfig(patch: Record<string, string>): Promise<void> {
  state.cfg = await api<ConfigView>('POST', ROUTES.config, { body: patch });
}

async function loadProducts(): Promise<void> {
  setBusy('products');
  try {
    const products = await api<ProductOption[]>('GET', ROUTES.products);
    state.products = products;
    const options: SelectOption[] = products.map((entry) => ({
      id: entry.id,
      label: entry.name,
      hint: `#${entry.id}`,
    }));
    productSelect?.update({ options, value: state.cfg?.product || null });
  } catch (error) {
    state.banner = { tone: 'error', title: '读取项目失败', body: describeError(error) };
    render();
  } finally {
    setBusy('');
  }
}

/**
   * Everything that hangs off the current product: its 迭代 and its members.
   * Both are fetched only once a product is chosen, and both are scoped to it.
   */
  async function loadProductContext(force = false): Promise<void> {
    const product = state.cfg?.product ?? '';
    if (!product) {
      state.executions = [];
      state.members = [];
      execSelect?.update({ options: [], value: null });
      memberSelect?.update({ options: [], value: null });
      return;
    }
    setBusy('context');
    try {
      const context = await api<ProductContext>('GET', ROUTES.executions, {
        query: { product, ...(force ? { refresh: '1' } : {}) },
      });
      state.executions = context.executions;
      state.members = context.members;

      const currentExecution = state.cfg?.execution ?? '';
      execSelect?.update({
        options: context.executions.map((entry) => ({
          id: entry.id,
          label: entry.name,
          hint: `#${entry.id}`,
        })),
        value: context.executions.some((entry) => entry.id === currentExecution)
          ? currentExecution
          : null,
      });

      // The 成员 filter is derived from the bug list, so it is rebuilt after
      // every load rather than from the product team alone.
      updateMemberOptions();
    } catch (error) {
      state.banner = { tone: 'error', title: '读取迭代 / 成员失败', body: describeError(error) };
      render();
    } finally {
      setBusy('');
    }
  }

  /**
   * Reads the whole bug list of the current product in one go.
   *
   * Nothing is filtered or paged on the wire: the panel narrows the set itself,
   * so a tab switch or a page turn costs nothing.
   */
  async function loadBugs(force = false): Promise<void> {
    const product = state.cfg?.product ?? '';
    if (!product) {
      render();
      return;
    }
    state.loading = true;
    state.selected = '';
    state.modal = null;
    render();
    try {
      const data = await api<BugList>('GET', ROUTES.bugs, {
        query: { product, ...(force ? { refresh: '1' } : {}) },
      });
      state.all = data.bugs;
      state.truncated = data.truncated;
      state.banner = null;
      paintFooter(`已读取 ${data.bugs.length} 条 bug`);
    } catch (error) {
      state.all = [];
      state.truncated = false;
      state.banner = { tone: 'error', title: '读取 bug 列表失败', body: describeError(error) };
      paintFooter('读取 bug 列表失败');
    } finally {
      // `loading` is what draws the spinner, so clearing it has to be followed
      // by the repaint — otherwise an empty list spins forever.
      state.loading = false;
      repaint(true);
    }
  }

async function chooseProduct(id: string): Promise<void> {
  try {
    await saveConfig({ product: id, execution: '', memberAccount: '' });
    productSelect?.update({ value: id });
    state.all = [];
    state.executions = [];
    state.members = [];
    execSelect?.update({ value: null, options: [] });
    memberSelect?.update({ value: null, options: [] });
    await Promise.all([loadProductContext(), loadBugs()]);
    void refreshBadge();
  } catch (error) {
    state.banner = { tone: 'error', title: '切换项目失败', body: describeError(error) };
    render();
  }
}

async function chooseExecution(id: string): Promise<void> {
  try {
    // The 成员 filter is scoped to the 迭代, so it resets together with it.
    await saveConfig({ execution: id, memberAccount: '' });
    execSelect?.update({ value: id });
    repaint();
  } catch (error) {
    state.banner = { tone: 'error', title: '切换迭代失败', body: describeError(error) };
    render();
  }
}

async function chooseMember(id: string): Promise<void> {
  const account = id === ALL_MEMBERS ? '' : id;
  try {
    await saveConfig({ memberAccount: account });
    repaint();
  } catch (error) {
    state.banner = { tone: 'error', title: '切换成员失败', body: describeError(error) };
    render();
  }
}

/** Opens the preview modal for a bug, or closes it if that bug is already shown. */
async function openPreview(bug: Bug): Promise<void> {
  if (state.modal?.id === bug.id) {
    closePreview();
    return;
  }
  setBusy('bug');
  try {
    const detail = await api<BugDetail>('GET', ROUTES.bug, { query: { id: bug.id } });
    state.modal = detail;
    state.selected = detail.id;
  } catch (error) {
    state.banner = { tone: 'error', title: '读取 bug 详情失败', body: describeError(error) };
  } finally {
    setBusy('');
    render();
  }
}

function closePreview(): void {
  if (!state.modal) return;
  if (state.selected === state.modal.id) state.selected = '';
  state.modal = null;
  render();
}

async function focusBug(bugId: string): Promise<void> {
  try {
    const detail = await api<BugDetail>('GET', ROUTES.bug, { query: { id: bugId } });
    state.modal = detail;
    state.selected = bugId;
    if (!state.all.some((bug) => bug.id === bugId)) state.all = [detail, ...state.all];
    repaint();
  } catch {
    // Opened from a chip for a bug outside the current filter — not an error.
  }
}

/** Boots (if needed) and offers a write-back for a session action's payload. */
function applyReadyItem(item: HostReadyContext['item']): void {
  if (!item) {
    void boot('');
    return;
  }
  if (isGuestSessionItem(item)) {
    void handleWritebackItem(item);
    return;
  }
  const data = 'data' in item ? item.data : undefined;
  const bugId =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as { bugId?: unknown }).bugId
      : undefined;
  void boot(typeof bugId === 'string' ? bugId : '');
}

/**
 * The 回写禅道 session action. OpenChamber delivers the conversation here, and
 * the panel turns the AI's last answer into a 解决 request waiting for a click.
 *
 * `ready.item` and `onItem` can both carry the same invocation, so the whole
 * path is guarded against running twice for one click.
 */
let writebackBusy = false;

async function handleWritebackItem(item: GuestSessionItem): Promise<void> {
  if (writebackBusy) return;
  writebackBusy = true;
  try {
    if (!state.cfg) await boot('');
    await openWriteback(item);
  } finally {
    writebackBusy = false;
  }
}

/** Fills the 解决 confirmation with the AI's conclusion for the bug it fixed. */
async function openWriteback(item: GuestSessionItem): Promise<void> {
  const bugId = bugIdFromItem(item);
  if (!bugId) {
    toast('error', '这个会话里找不到禅道 bug 号，无法回写');
    return;
  }
  setBusy('bug');
  try {
    const detail = await api<BugDetail>('GET', ROUTES.bug, { query: { id: bugId } });
    state.pending = { kind: 'resolve', bug: detail, comment: writebackComment(item), auto: true };
    state.selected = bugId;
  } catch (error) {
    state.banner = { tone: 'error', title: '读取 bug 详情失败', body: describeError(error) };
    toast('error', describeError(error));
  } finally {
    setBusy('');
    render();
  }
}

/** Finds the bug id in an action payload: first our own prompt, then the title. */
function bugIdFromItem(item: GuestSessionItem): string {
  const texts = (item.messages ?? []).map((message) => message.text);
  for (const text of texts) {
    const exact = /请修复禅道 bug #(\d+)/.exec(text);
    if (exact?.[1]) return exact[1];
  }
  for (const text of texts) {
    const any = /bugID=(\d+)/i.exec(text) ?? /#(\d+)/.exec(text);
    if (any?.[1]) return any[1];
  }
  return /#(\d+)/.exec(item.sessionTitle)?.[1] ?? '';
}

/** ZenTao comments have no documented cap; keep them well under the wire limit. */
const COMMENT_MAX = 20000;

/** The AI's closing summary, packaged as the 解决 comment. */
function writebackComment(item: GuestSessionItem): string {
  const last = [...(item.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant' && message.text.trim());
  if (!last) return defaultComment();
  return clip(`【AI 修复结论（自动回写）】\n${last.text.trim()}`, COMMENT_MAX);
}

function promptFor(bug: BugDetail): string {
  const lines: string[] = [
    `请修复禅道 bug #${bug.id}。`,
    '',
    `标题：${bug.title}`,
    `链接：${bug.url}`,
    `类型：${bug.type || '-'} · 优先级：${bug.pri || '-'} · 严重程度：${bug.severity || '-'} · 状态：${statusLabel(bug.status)}`,
    `指派给：${nameOf(bug.assignedTo)} · 报告人：${bug.openedBy || '-'}`,
  ];
  if (bug.module) lines.push(`模块：${bug.module}`);
  if (bug.os || bug.browser) lines.push(`平台：${bug.os || '-'} / ${bug.browser || '-'}`);
  if (bug.openedBuild) lines.push(`影响版本：${bug.openedBuild}`);
  if (bug.steps) lines.push('', '重现步骤：', bug.steps);
  lines.push(
    '',
    '请按下面的流程处理：',
    '1. 在当前打开的项目里读代码，定位真实根因，不要只改表面现象；',
    '2. 实施修复；',
    '3. 汇报根因、修改内容与修复版本（分支@提交）；',
    '4. 在我确认之前不要写回禅道，也不要自动 resolve / close。',
    '5. 收尾时用一段简短的「修复结论」总结根因、修改内容与修复版本，方便回写禅道。',
    '如果当前项目里有配套的 bug 修复流程 skill，请优先遵循它。',
  );
  return clip(lines.join('\n'), PROMPT_MAX);
}

/**
 * Starts a fresh session for one bug and attaches it as a chip, so the new
 * chat carries both the bug address and its context prompt.
 *
 * By default the prompt is left in the composer as a draft; the toolbar switch
 * makes the new session send it straight away.
 */
async function aiFix(bug: Bug): Promise<void> {
  setBusy('bug');
  try {
    const detail = await api<BugDetail>('GET', ROUTES.bug, { query: { id: bug.id } });
    const item = {
      providerId: 'zentao-bug-assistant',
      id: `zentao-${detail.id}`,
      title: `#${detail.id} ${detail.title}`,
      url: detail.url,
      kind: 'issue' as const,
      data: { bugId: detail.id },
    };
    const created = await host.startSession({
      ...item,
      navigation: 'open',
      // Passing `text` sends it as the first message; omitting it leaves a draft.
      ...(state.directSend ? { text: promptFor(detail) } : {}),
    });
    if (created.sessionId === null) {
      throw new Error(`新会话创建失败（${created.failure}）`);
    }
    if (state.directSend) {
      if (created.sent === 'sent') {
        toast('success', `已新建会话，并把 #${detail.id} 交给 AI 修复`);
      } else {
        toast('info', `会话已新建，但提示词没有发送（${created.sent}）`);
      }
      return;
    }
    try {
      await host.prompt({ text: promptFor(detail) });
      toast(
        'info',
        created.linked === false
          ? `已新建草稿会话；#${detail.id} 的卡片没挂上，提示词已填入输入框`
          : `已新建草稿会话，并带上 #${detail.id} 的地址`,
      );
    } catch (error) {
      // The session exists, so this is a partial success — say so plainly.
      toast('error', `会话已新建，但提示词没能填入：${describeError(error)}`);
    }
  } catch (error) {
    state.banner = { tone: 'error', title: '发起 AI 修复失败', body: describeError(error) };
    render();
    toast('error', describeError(error));
  } finally {
    setBusy('');
  }
}

async function openConfirm(kind: PendingKind, bug: Bug): Promise<void> {
  setBusy('bug');
  try {
    const detail = await api<BugDetail>('GET', ROUTES.bug, { query: { id: bug.id } });
    state.pending = { kind, bug: detail, comment: defaultComment() };
    state.selected = bug.id;
  } catch (error) {
    state.banner = { tone: 'error', title: '读取 bug 详情失败', body: describeError(error) };
  } finally {
    setBusy('');
    render();
  }
}

function defaultComment(): string {
  return ['【根因】', '【修复内容】', '【修复版本】'].join('\n');
}

async function commitPending(pending: Pending): Promise<void> {
  setBusy('write');
  try {
    if (pending.kind === 'resolve') {
      await api('POST', ROUTES.resolve, {
        body: {
          id: pending.bug.id,
          comment: pending.comment,
          resolution: 'resolved',
          resolvedBuild: state.cfg?.resolvedBuild || 'trunk',
        },
      });
    } else {
      await api('POST', ROUTES.close, {
        body: { id: pending.bug.id, comment: pending.comment },
      });
    }
    toast('success', `#${pending.bug.id} 已${pending.kind === 'resolve' ? '解决' : '关闭'}`);
    state.pending = null;
    await loadBugs();
    void refreshBadge();
  } catch (error) {
    state.banner = { tone: 'error', title: '写回禅道失败', body: describeError(error) };
    render();
    toast('error', describeError(error));
  } finally {
    setBusy('');
  }
}

async function refreshSession(): Promise<void> {
  try {
    const view = await api<SessionView>('GET', ROUTES.session);
    if (view.keepAlive?.message) paintFooter(view.keepAlive.message);
  } catch {
    // The footer is informational only.
  }
}

async function refreshBadge(): Promise<void> {
  const account = state.cfg?.account ?? '';
  const product = state.cfg?.product ?? '';
  if (!account || !product) {
    void host.setBadge(null).catch(() => undefined);
    return;
  }
  try {
    const data = await api<BugList>('GET', ROUTES.bugs, {
      query: { product, status: 'active', assignedTo: account },
    });
    void host.setBadge(Math.min(999, data.total)).catch(() => undefined);
  } catch {
    // Badges are optional chrome.
  }
}

/* ------------------------------------------------------------ host wiring */

host.onResolve((request) => {
  if (request.command !== 'zentao') return null;
  const id = request.args.trim().replace(/^#/, '');
  if (!/^\d+$/.test(id)) {
    toast('error', '用法：/zentao <bugID>，例如 /zentao 3986');
    return null;
  }
  return api<BugDetail>('GET', ROUTES.bug, { query: { id } }).then(
    (detail) => ({
      providerId: 'zentao-bug-assistant',
      id: `zentao-${detail.id}`,
      title: `#${detail.id} ${detail.title}`,
      url: detail.url,
      kind: 'issue' as const,
      text: promptFor(detail),
      data: { bugId: detail.id },
    }),
    (error: unknown) => {
      toast('error', describeError(error));
      return null;
    },
  );
});

// A chip carrying one of our bugs brings the panel back to it.
host.onItem((item) => {
  if (!item) return;
  // A session action delivers the conversation; every other item is a chip.
  if (isGuestSessionItem(item)) {
    void handleWritebackItem(item);
    return;
  }
  const data = 'data' in item ? item.data : undefined;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const bugId = (data as { bugId?: unknown }).bugId;
  if (typeof bugId === 'string' && bugId) void focusBug(bugId);
});

setInterval(() => {
  void refreshSession();
}, 60_000);