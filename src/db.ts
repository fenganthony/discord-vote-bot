import type { Env, GuildConfig, Poll, PollOption, Vote } from './types';

const DEFAULT_TZ = 'Asia/Taipei';

// ---------- 伺服器設定 ----------

export async function getConfig(env: Env, guildId: string): Promise<GuildConfig> {
  const row = await env.DB.prepare('SELECT * FROM guild_config WHERE guild_id = ?').bind(guildId).first<GuildConfig>();
  return (
    row ?? {
      guild_id: guildId,
      admin_role_id: null,
      check_role_id: null,
      tag_role_id: null,
      auto_tag: 0,
      timezone: DEFAULT_TZ,
      sheet_id: null,
    }
  );
}

export async function updateConfig(env: Env, guildId: string, patch: Partial<Omit<GuildConfig, 'guild_id'>>) {
  const c = { ...(await getConfig(env, guildId)), ...patch };
  await env.DB.prepare(
    `INSERT INTO guild_config (guild_id, admin_role_id, check_role_id, tag_role_id, auto_tag, timezone, sheet_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET
       admin_role_id = excluded.admin_role_id, check_role_id = excluded.check_role_id,
       tag_role_id = excluded.tag_role_id, auto_tag = excluded.auto_tag,
       timezone = excluded.timezone, sheet_id = excluded.sheet_id`,
  )
    .bind(guildId, c.admin_role_id, c.check_role_id, c.tag_role_id, c.auto_tag, c.timezone, c.sheet_id)
    .run();
  return c;
}

// ---------- 投票 ----------

export const getPoll = (env: Env, id: string) =>
  env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(id).first<Poll>();

export async function getOptions(env: Env, pollId: string) {
  const r = await env.DB.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY idx').bind(pollId).all<PollOption>();
  return r.results;
}

export async function getVotes(env: Env, pollId: string) {
  const r = await env.DB.prepare('SELECT * FROM votes WHERE poll_id = ? ORDER BY option_idx, voted_at').bind(pollId).all<Vote>();
  return r.results;
}

export async function loadPoll(env: Env, id: string) {
  const [poll, options, votes] = await Promise.all([getPoll(env, id), getOptions(env, id), getVotes(env, id)]);
  return { poll, options, votes };
}

export async function insertPoll(env: Env, p: Poll, options: PollOption[]) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO polls (id, guild_id, channel_id, message_id, title, content, status, deadline_at, check_role_id, created_by, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(p.id, p.guild_id, p.channel_id, p.message_id, p.title, p.content, p.status, p.deadline_at, p.check_role_id, p.created_by, p.created_at, p.closed_at),
    ...options.map((o) =>
      env.DB.prepare(
        'INSERT INTO poll_options (poll_id, idx, label, emoji_id, emoji_name, emoji_animated, kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(o.poll_id, o.idx, o.label, o.emoji_id, o.emoji_name, o.emoji_animated, o.kind),
    ),
  ]);
}

export async function pollIdExists(env: Env, id: string) {
  return !!(await env.DB.prepare('SELECT 1 FROM polls WHERE id = ?').bind(id).first());
}

type PollPatch = Partial<Pick<Poll, 'title' | 'content' | 'deadline_at' | 'status' | 'closed_at' | 'message_id'>>;

export async function updatePoll(env: Env, id: string, patch: PollPatch) {
  const keys = Object.keys(patch) as (keyof PollPatch)[];
  if (!keys.length) return;
  await env.DB.prepare(`UPDATE polls SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => patch[k] ?? null), id)
    .run();
}

/** 只在仍為 open 時關閉，回傳是否真的由這次呼叫關閉（避免手動截止與 alarm 重複處理） */
export async function markClosed(env: Env, id: string, now: number) {
  const r = await env.DB.prepare("UPDATE polls SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").bind(now, id).run();
  return r.meta.changes > 0;
}

export async function listPolls(env: Env, guildId: string, status: 'open' | 'closed' | null, limit = 20) {
  const r = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM votes v WHERE v.poll_id = p.id) AS vote_count
     FROM polls p WHERE p.guild_id = ? AND (? IS NULL OR p.status = ?)
     ORDER BY p.created_at DESC LIMIT ?`,
  )
    .bind(guildId, status, status, limit)
    .all<Poll & { vote_count: number }>();
  return r.results;
}

export async function searchPolls(env: Env, guildId: string, q: string) {
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const r = await env.DB.prepare(
    `SELECT * FROM polls WHERE guild_id = ? AND (id LIKE ? OR title LIKE ?)
     ORDER BY status = 'open' DESC, created_at DESC LIMIT 25`,
  )
    .bind(guildId, like.toUpperCase(), like)
    .all<Poll>();
  return r.results;
}

export async function overduePolls(env: Env, before: number) {
  const r = await env.DB.prepare("SELECT id FROM polls WHERE status = 'open' AND deadline_at <= ? LIMIT 50").bind(before).all<{ id: string }>();
  return r.results.map((x) => x.id);
}

export async function deletePollRows(env: Env, id: string) {
  await env.DB.batch(
    ['votes', 'poll_options', 'tagged'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE poll_id = ?`).bind(id)).concat(
      env.DB.prepare('DELETE FROM polls WHERE id = ?').bind(id),
    ),
  );
}

// ---------- 選票 ----------

export const getVote = (env: Env, pollId: string, userId: string) =>
  env.DB.prepare('SELECT * FROM votes WHERE poll_id = ? AND user_id = ?').bind(pollId, userId).first<Vote>();

export async function upsertVote(env: Env, v: Vote) {
  await env.DB.prepare(
    `INSERT INTO votes (poll_id, user_id, option_idx, display_name, reason, voted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (poll_id, user_id) DO UPDATE SET
       option_idx = excluded.option_idx, display_name = excluded.display_name,
       reason = excluded.reason, updated_at = excluded.updated_at`,
  )
    .bind(v.poll_id, v.user_id, v.option_idx, v.display_name, v.reason, v.voted_at, v.updated_at)
    .run();
}

export async function deleteVote(env: Env, pollId: string, userId: string) {
  const r = await env.DB.prepare('DELETE FROM votes WHERE poll_id = ? AND user_id = ?').bind(pollId, userId).run();
  return r.meta.changes > 0;
}

// ---------- 標記身分組紀錄 ----------

export async function getTagged(env: Env, pollId: string) {
  const r = await env.DB.prepare('SELECT user_id, role_id FROM tagged WHERE poll_id = ?').bind(pollId).all<{ user_id: string; role_id: string }>();
  return r.results;
}

export const getTaggedUser = (env: Env, pollId: string, userId: string) =>
  env.DB.prepare('SELECT role_id FROM tagged WHERE poll_id = ? AND user_id = ?').bind(pollId, userId).first<{ role_id: string }>();

export async function addTagged(env: Env, pollId: string, roleId: string, userIds: string[]) {
  if (!userIds.length) return;
  await env.DB.batch(
    userIds.map((u) => env.DB.prepare('INSERT OR REPLACE INTO tagged (poll_id, user_id, role_id) VALUES (?, ?, ?)').bind(pollId, u, roleId)),
  );
}

export async function removeTagged(env: Env, pollId: string, userIds: string[]) {
  if (!userIds.length) return;
  await env.DB.batch(userIds.map((u) => env.DB.prepare('DELETE FROM tagged WHERE poll_id = ? AND user_id = ?').bind(pollId, u)));
}

// ---------- 選項範本 ----------

export const getTemplate = (env: Env, guildId: string, name: string) =>
  env.DB.prepare('SELECT * FROM templates WHERE guild_id = ? AND name = ?').bind(guildId, name).first<{ name: string; options_text: string }>();

export async function listTemplates(env: Env, guildId: string) {
  const r = await env.DB.prepare('SELECT * FROM templates WHERE guild_id = ? ORDER BY name').bind(guildId).all<{ name: string; options_text: string }>();
  return r.results;
}

export async function saveTemplate(env: Env, guildId: string, name: string, text: string) {
  await env.DB.prepare('INSERT OR REPLACE INTO templates (guild_id, name, options_text) VALUES (?, ?, ?)').bind(guildId, name, text).run();
}

export async function deleteTemplate(env: Env, guildId: string, name: string) {
  const r = await env.DB.prepare('DELETE FROM templates WHERE guild_id = ? AND name = ?').bind(guildId, name).run();
  return r.meta.changes > 0;
}

// ---------- 建立投票暫存 ----------

export async function putPending(env: Env, nonce: string, data: unknown) {
  await env.DB.prepare('INSERT INTO pending (nonce, data, created_at) VALUES (?, ?, ?)').bind(nonce, JSON.stringify(data), Date.now()).run();
}

export async function takePending<T>(env: Env, nonce: string): Promise<T | null> {
  const row = await env.DB.prepare('DELETE FROM pending WHERE nonce = ? RETURNING data').bind(nonce).first<{ data: string }>();
  return row ? (JSON.parse(row.data) as T) : null;
}

export async function cleanupPending(env: Env) {
  await env.DB.prepare('DELETE FROM pending WHERE created_at < ?').bind(Date.now() - 24 * 3600_000).run();
}
