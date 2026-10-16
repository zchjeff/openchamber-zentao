import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The service owns its configuration outright: this plugin is standalone and
 * never reads or writes state that belongs to another project.
 *
 * The file holds the password in clear text, so it is written 0600.
 */
export type StoredConfig = {
  base: string;
  account: string;
  password: string;
  token: string;
  realname: string;
  product: string;
  execution: string;
  memberAccount: string;
  resolvedBuild: string;
};

export const CONFIG_DIR = join(homedir(), '.openchamber-zentao');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export const EMPTY_CONFIG: StoredConfig = {
  base: '',
  account: '',
  password: '',
  token: '',
  realname: '',
  product: '',
  execution: '',
  memberAccount: '',
  resolvedBuild: 'trunk',
};

const STRING_KEYS: Array<keyof StoredConfig> = [
  'base',
  'account',
  'password',
  'token',
  'realname',
  'product',
  'execution',
  'memberAccount',
  'resolvedBuild',
];

export async function loadConfig(): Promise<StoredConfig> {
  try {
    const text = await readFile(CONFIG_PATH, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...EMPTY_CONFIG };
    }
    const record = parsed as Record<string, unknown>;
    const config = { ...EMPTY_CONFIG };
    for (const key of STRING_KEYS) {
      const value = record[key];
      if (typeof value === 'string') config[key] = value;
    }
    return config;
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export async function saveConfig(config: StoredConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Write beside the target and rename, so a crash never leaves a half file.
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, CONFIG_PATH);
  try {
    await chmod(CONFIG_PATH, 0o600);
  } catch {
    // A filesystem without POSIX modes is not a reason to fail the save.
  }
}

/** Copies only the known string fields out of a request body. */
export function pickPatch(body: Record<string, unknown>): Partial<StoredConfig> {
  const patch: Partial<StoredConfig> = {};
  for (const key of STRING_KEYS) {
    const value = body[key];
    if (typeof value === 'string') patch[key] = value;
  }
  return patch;
}