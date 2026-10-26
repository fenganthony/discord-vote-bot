import type { Ctx, Env, GuildConfig, MessagePayload } from './types';
import { editOriginal, explainError } from './discord';
import { getConfig, getPoll } from './db';
import { normalizeId } from './util';

export const EPHEMERAL = 64;
const NO_MENTIONS = { parse: [] as string[] };

export const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

export function reply(content: string, opts: { ephemeral?: boolean; embeds?: unknown[]; components?: unknown[] } = {}) {
  return json({
    type: 4,
    data: {
      content: content || undefined,
      embeds: opts.embeds,
      components: opts.components,
      flags: opts.ephemeral === false ? 0 : EPHEMERAL,
      allowed_mentions: NO_MENTIONS,
    },
  });
}

export interface TextInput {
  custom_id: string;
  label: string;
  style: 1 | 2;
  required?: boolean;
  max_length?: number;
  placeholder?: string;
  value?: string;
}

export const modal = (custom_id: string, title: string, inputs: TextInput[]) =>
  json({ type: 9, data: { custom_id, title, components: inputs.map((t) => ({ type: 1, components: [{ type: 4, ...t }] })) } });

/** 先回 defer，實際工作在背景做完後編輯原回覆（適合要打 Discord API、可能超過 3 秒的指令） */
export function deferred(c: Ctx, work: () => Promise<MessagePayload>, ephemeral = true) {
  const appId = c.i.application_id;
  const token = c.i.token;
  c.ctx.waitUntil(
    work()
      .then((p) => editOriginal(c.env, appId, token, p))
      .catch(async (e) => {
        console.error(e);
        await editOriginal(c.env, appId, token, { content: `⚠️ ${explainError(e)}` }).catch(() => {});
      }),
  );
  return json({ type: 5, data: { flags: ephemeral ? EPHEMERAL : 0 } });
}

/** 取出 subcommand 名稱與參數 */
export function subcommand(i: any): { name: string; o: Record<string, any> } {
  const sub = i.data.options?.[0];
  const o: Record<string, any> = {};
  for (const x of sub?.options ?? []) o[x.name] = x.value;
  return { name: sub?.name ?? '', o };
}

/** Modal 送出的欄位（遞迴走訪，相容 Action Row 與 Label 兩種包裝） */
export function modalFields(components: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (typeof n.custom_id === 'string' && typeof n.value === 'string') out[n.custom_id] = n.value;
    walk(n.components);
    walk(n.component);
  };
  walk(components);
  return out;
}

export const userOf = (i: any) => i.member?.user ?? i.user;

export function displayNameOf(i: any): string {
  const u = userOf(i);
  return i.member?.nick || u.global_name || u.username;
}

const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

export async function isManager(env: Env, i: any, cfg?: GuildConfig) {
  const perms = BigInt(i.member?.permissions ?? '0');
  if (perms & (ADMINISTRATOR | MANAGE_GUILD)) return true;
  const c = cfg ?? (await getConfig(env, i.guild_id));
  return !!c.admin_role_id && (i.member?.roles ?? []).includes(c.admin_role_id);
}

export const NOT_MANAGER = '🚫 需要「管理伺服器」權限，或擁有 `/vote-config admin-role` 設定的投票管理身分組。';

/** 依 ID 找投票，且必須屬於目前的伺服器 */
export async function findPoll(env: Env, guildId: string, id: unknown) {
  const poll = await getPoll(env, normalizeId(id));
  return poll && poll.guild_id === guildId ? poll : null;
}
