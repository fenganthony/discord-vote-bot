import type { Env, FileSpec, Member, MessagePayload } from './types';

const API = 'https://discord.com/api/v10';
const NO_MENTIONS = { parse: [] as string[] };

export class DiscordError extends Error {
  constructor(public status: number, public body: string, path: string) {
    super(`Discord API ${status} ${path}: ${body.slice(0, 300)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ApiOptions {
  body?: unknown;
  form?: FormData;
  reason?: string;
  auth?: boolean;
}

export async function api<T = any>(env: Env, method: string, path: string, opts: ApiOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = {};
    if (opts.auth !== false) headers.Authorization = `Bot ${env.DISCORD_TOKEN}`;
    if (opts.reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(opts.reason);
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(API + path, { method, headers, body });
    if (res.status === 429 && attempt < 4) {
      const info: any = await res.json().catch(() => ({}));
      await sleep(Math.min((info.retry_after ?? 1) * 1000 + 100, 15_000));
      continue;
    }
    if (!res.ok) throw new DiscordError(res.status, await res.text(), path);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

function multipart(payload: object, files: FileSpec[]): FormData {
  const form = new FormData();
  const withAttachments = { ...payload, attachments: files.map((f, id) => ({ id, filename: f.name })) };
  form.append('payload_json', JSON.stringify(withAttachments));
  files.forEach((f, i) => {
    const blob = f.data instanceof Blob ? f.data : new Blob([f.data], { type: f.type ?? 'application/octet-stream' });
    form.append(`files[${i}]`, blob, f.name);
  });
  return form;
}

function send(env: Env, method: string, path: string, payload: MessagePayload, auth = true) {
  const { files, ...rest } = payload;
  const body = { allowed_mentions: NO_MENTIONS, ...rest };
  if (files?.length) return api(env, method, path, { form: multipart(body, files), auth });
  return api(env, method, path, { body, auth });
}

export const sendMessage = (env: Env, channelId: string, payload: MessagePayload & Record<string, unknown>) =>
  send(env, 'POST', `/channels/${channelId}/messages`, payload) as Promise<{ id: string }>;

export const editMessage = (env: Env, channelId: string, messageId: string, payload: MessagePayload) =>
  send(env, 'PATCH', `/channels/${channelId}/messages/${messageId}`, payload);

export const deleteMessage = (env: Env, channelId: string, messageId: string) =>
  api(env, 'DELETE', `/channels/${channelId}/messages/${messageId}`);

/** 編輯 interaction 的原始回覆（defer 後用，token 有效 15 分鐘） */
export const editOriginal = (env: Env, appId: string, token: string, payload: MessagePayload) =>
  send(env, 'PATCH', `/webhooks/${appId}/${token}/messages/@original`, payload, false);

export const guildEmojis = (env: Env, guildId: string) =>
  api<{ id: string; name: string; animated?: boolean }[]>(env, 'GET', `/guilds/${guildId}/emojis`);

/** 列出整個伺服器成員（需在 Developer Portal 開啟 Server Members Intent） */
export async function listMembers(env: Env, guildId: string): Promise<Member[]> {
  const all: Member[] = [];
  let after = '0';
  for (let page = 0; page < 50; page++) {
    const batch = await api<Member[]>(env, 'GET', `/guilds/${guildId}/members?limit=1000&after=${after}`);
    all.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  return all;
}

export const addRole = (env: Env, guildId: string, userId: string, roleId: string, reason: string) =>
  api(env, 'PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, { reason });

export const removeRole = (env: Env, guildId: string, userId: string, roleId: string, reason: string) =>
  api(env, 'DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, { reason });

export function memberName(m: { nick?: string | null; user: { username: string; global_name?: string | null } }): string {
  return m.nick || m.user.global_name || m.user.username;
}

/** 把 Discord 錯誤轉成給管理員看的中文提示 */
export function explainError(e: unknown): string {
  if (e instanceof DiscordError) {
    if (e.status === 403 || e.body.includes('50013') || e.body.includes('50001'))
      return 'bot 權限不足：請確認 bot 能在該頻道「檢視頻道、發送訊息、嵌入連結、附加檔案」，並有「管理身分組」權限。';
    if (e.status === 404) return '找不到目標（訊息、頻道或成員可能已被刪除）。';
    return `Discord 回傳錯誤 ${e.status}`;
  }
  return e instanceof Error ? e.message : String(e);
}
