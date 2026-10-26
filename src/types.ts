import type { PollDO } from './poll-do';

export interface Env {
  DB: D1Database;
  POLL_DO: DurableObjectNamespace<PollDO>;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_TOKEN: string;
  GOOGLE_SA_EMAIL?: string;
  GOOGLE_SA_KEY?: string;
}

export interface Ctx {
  env: Env;
  ctx: ExecutionContext;
  // Discord interaction payload（結構很大，這裡不逐欄定義型別）
  i: any;
}

export interface GuildConfig {
  guild_id: string;
  admin_role_id: string | null;
  check_role_id: string | null;
  tag_role_id: string | null;
  auto_tag: number;
  timezone: string;
  sheet_id: string | null;
}

export interface Poll {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  content: string;
  status: 'open' | 'closed';
  deadline_at: number;
  check_role_id: string | null;
  created_by: string;
  created_at: number;
  closed_at: number | null;
}

export type OptionKind = 'class' | 'leave';

export interface PollOption {
  poll_id: string;
  idx: number;
  label: string;
  emoji_id: string | null;
  emoji_name: string | null;
  emoji_animated: number;
  kind: OptionKind;
}

export interface Vote {
  poll_id: string;
  user_id: string;
  option_idx: number;
  display_name: string;
  reason: string | null;
  voted_at: number;
  updated_at: number;
}

export interface Member {
  user: { id: string; username: string; global_name?: string | null; bot?: boolean };
  nick?: string | null;
  roles: string[];
}

export type JobNotify =
  | { kind: 'interaction'; appId: string; token: string }
  | { kind: 'channel'; channelId: string };

// 批次加 / 移除身分組的工作，交給 Durable Object 分批跑以避開速率與子請求限制
export interface RoleJob {
  pollId: string;
  guildId: string;
  roleId: string;
  mode: 'add' | 'remove';
  userIds: string[];
  cursor: number;
  ok: number;
  failed: { id: string; status: number }[];
  notify: JobNotify | null;
}

export interface FileSpec {
  name: string;
  data: Blob | string;
  type?: string;
}

export interface MessagePayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  files?: FileSpec[];
}
