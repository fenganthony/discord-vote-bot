import type { Ctx, GuildConfig, Poll } from '../types';
import { getConfig, getTagged, getTemplate, listPolls, loadPoll, putPending, updatePoll } from '../db';
import { explainError, memberName } from '../discord';
import { exportRows, toCsv } from '../export';
import { sheetsConfigured, writePollSheet } from '../google';
import { DEFAULT_OPTIONS_TEXT } from '../options';
import { closePoll, computeProgress, newRoleJob, pollStub, refreshMessage } from '../poll-service';
import { renderStatus } from '../render';
import { deferred, findPoll, isManager, modal, NOT_MANAGER, reply, subcommand } from '../respond';
import { parseDeadline } from '../time';
import { joinLimited, truncate, unix } from '../util';

export interface PendingCreate {
  channelId: string;
  checkRoleId: string | null;
  image: { url: string; filename: string; contentType: string } | null;
}

export async function handleVote(c: Ctx): Promise<Response> {
  const { name, o } = subcommand(c.i);
  const cfg = await getConfig(c.env, c.i.guild_id);
  if (!(await isManager(c.env, c.i, cfg))) return reply(NOT_MANAGER);

  if (name === 'create') return create(c, o);
  if (name === 'list') return list(c, o);

  const poll = await findPoll(c.env, c.i.guild_id, o.id);
  if (!poll) return reply(`❓ 找不到投票 \`${o.id}\`，可以用 \`/vote list\` 查看。`);

  switch (name) {
    case 'close':
      return close(c, poll);
    case 'edit':
      return edit(c, poll, o, cfg);
    case 'status':
      return status(c, poll, o);
    case 'export':
      return exportPoll(c, poll, o, cfg);
    case 'delete':
      return reply(`⚠️ 確定要刪除投票 \`${poll.id}\`「${poll.title}」？頻道中的投票訊息與所有選票都會一併刪除，無法復原。`, {
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 4, label: '確定刪除', custom_id: `del:${poll.id}` },
              { type: 2, style: 2, label: '取消', custom_id: `delx:${poll.id}` },
            ],
          },
        ],
      });
    case 'progress':
      return progress(c, poll, o, cfg);
    case 'tag':
      return tag(c, poll, o, cfg);
    case 'untag':
      return untag(c, poll);
  }
  return reply('未知的子指令');
}

async function create(c: Ctx, o: Record<string, any>) {
  const att = o.image ? c.i.data.resolved?.attachments?.[o.image] : null;
  if (att && !String(att.content_type ?? '').startsWith('image/')) return reply('🖼️ 附件必須是圖片檔。');
  if (att && att.size > 10 * 1024 * 1024) return reply('🖼️ 圖片請小於 10MB。');

  let optionsText = DEFAULT_OPTIONS_TEXT;
  if (o.template) {
    const t = await getTemplate(c.env, c.i.guild_id, o.template);
    if (!t) return reply(`找不到選項範本「${o.template}」，可用 \`/vote-template list\` 查看。`);
    optionsText = t.options_text;
  }

  const nonce = crypto.randomUUID().replace(/-/g, '');
  const pending: PendingCreate = {
    channelId: o.channel ?? c.i.channel_id,
    checkRoleId: o.check_role ?? null,
    image: att ? { url: att.url, filename: att.filename, contentType: att.content_type } : null,
  };
  await putPending(c.env, nonce, pending);

  return modal(`c:${nonce}`, '建立投票', [
    { custom_id: 'title', label: '標題', style: 1, required: true, max_length: 200 },
    { custom_id: 'content', label: '內容（可留空）', style: 2, required: false, max_length: 4000 },
    { custom_id: 'options', label: '選項：一行一個，前面可放表情，請假加 [請假]', style: 2, required: true, max_length: 4000, value: optionsText },
    { custom_id: 'deadline', label: '截止時間', style: 1, required: true, max_length: 50, placeholder: '2026-11-01 21:00、明天 21:00、3d' },
  ]);
}

async function list(c: Ctx, o: Record<string, any>) {
  const status = o.status === 'open' || o.status === 'closed' ? o.status : null;
  const polls = await listPolls(c.env, c.i.guild_id, status);
  if (!polls.length) return reply('目前沒有投票。用 `/vote create` 建立一個吧！');
  const lines = polls.map(
    (p) => `${p.status === 'open' ? '🟢' : '🔒'} \`${p.id}\` **${truncate(p.title, 60)}**・截止 <t:${unix(p.deadline_at)}:f>・${p.vote_count} 票`,
  );
  return reply('', { embeds: [{ title: '🗳️ 投票列表', description: lines.join('\n'), color: 0x5865f2 }] });
}

function close(c: Ctx, poll: Poll) {
  return deferred(c, async () => {
    if (poll.status === 'closed') return { content: `投票 \`${poll.id}\` 已經截止了。` };
    const r = await closePoll(c.env, poll.id);
    const stub = pollStub(c.env, poll.id);
    await stub.setDeadline(poll.id, null);
    if (r.job) await stub.enqueueRoleJob(r.job);
    return { content: `🔒 已截止投票 \`${poll.id}\`${r.job ? `，並開始把 ${r.job.userIds.length} 位未投票者加入標記身分組` : ''}。` };
  });
}

function edit(c: Ctx, poll: Poll, o: Record<string, any>, cfg: GuildConfig) {
  const patch: Parameters<typeof updatePoll>[2] = {};
  if (o.title) patch.title = String(o.title).slice(0, 200);
  if (o.content !== undefined) patch.content = String(o.content).replace(/\\n/g, '\n');
  if (o.deadline) {
    const d = parseDeadline(o.deadline, cfg.timezone, Date.now());
    if ('error' in d) return reply(`❌ ${d.error}`);
    patch.deadline_at = d.at;
    if (poll.status === 'closed') {
      patch.status = 'open';
      patch.closed_at = null;
    }
  }
  if (!Object.keys(patch).length) return reply('沒有要修改的內容（可修改 deadline / title / content）。');
  return deferred(c, async () => {
    await updatePoll(c.env, poll.id, patch);
    await refreshMessage(c.env, poll.id);
    if (patch.deadline_at) await pollStub(c.env, poll.id).setDeadline(poll.id, patch.deadline_at);
    const reopened = patch.status === 'open' ? '（已重新開放投票）' : '';
    const dl = patch.deadline_at ? `，截止改為 <t:${unix(patch.deadline_at)}:F>` : '';
    return { content: `✏️ 已更新投票 \`${poll.id}\`${dl}${reopened}` };
  });
}

async function status(c: Ctx, poll: Poll, o: Record<string, any>) {
  const { options, votes } = await loadPoll(c.env, poll.id);
  return reply('', { ephemeral: !o.public, embeds: [renderStatus(poll, options, votes)] });
}

function exportPoll(c: Ctx, poll: Poll, o: Record<string, any>, cfg: GuildConfig) {
  const format = o.format === 'sheets' ? 'sheets' : 'csv';
  if (format === 'sheets' && !sheetsConfigured(c.env)) return reply('尚未設定 Google service account（GOOGLE_SA_EMAIL / GOOGLE_SA_KEY），請先改用 CSV。');
  if (format === 'sheets' && !cfg.sheet_id) return reply('請先用 `/vote-config sheet` 設定要同步的 Google 試算表。');

  return deferred(c, async () => {
    const { options, votes } = await loadPoll(c.env, poll.id);
    const checkRole = poll.check_role_id ?? cfg.check_role_id;
    let nonVoters: Awaited<ReturnType<typeof computeProgress>>['notVoted'] = [];
    let note = '';
    if (checkRole) {
      try {
        nonVoters = (await computeProgress(c.env, poll, checkRole, votes)).notVoted;
        note = `（含 <@&${checkRole}> 中 ${nonVoters.length} 位未投票者）`;
      } catch (e) {
        note = `（未投票名單取得失敗：${explainError(e)}）`;
      }
    }
    const rows = exportRows(poll, options, votes, nonVoters, cfg.timezone);
    if (format === 'sheets') {
      const url = await writePollSheet(c.env, cfg.sheet_id!, poll.id, poll.title, rows);
      return { content: `📤 已同步 ${votes.length} 筆選票到 Google 試算表${note}\n${url}` };
    }
    return {
      content: `📤 投票 \`${poll.id}\` 共 ${votes.length} 筆選票${note}`,
      files: [{ name: `vote-${poll.id}.csv`, data: toCsv(rows), type: 'text/csv;charset=utf-8' }],
    };
  });
}

function progress(c: Ctx, poll: Poll, o: Record<string, any>, cfg: GuildConfig) {
  const roleId = o.role ?? poll.check_role_id ?? cfg.check_role_id;
  if (!roleId) return reply('請指定 `role`，或先用 `/vote-config check-role` 設定預設檢查的身分組。');
  return deferred(
    c,
    async () => {
      const { votes } = await loadPoll(c.env, poll.id);
      const p = await computeProgress(c.env, poll, roleId, votes);
      const total = p.members.length;
      const pct = total ? Math.round((p.voted.length / total) * 100) : 0;
      const mention = (m: (typeof p.members)[number]) => `<@${m.user.id}>`;
      return {
        embeds: [
          {
            title: truncate(`📋 投票進度：${poll.title}`, 256),
            description:
              `ID \`${poll.id}\`・身分組 <@&${roleId}>\n` +
              `已投 **${p.voted.length}** / ${total}（${pct}%）・未投 **${p.notVoted.length}**` +
              (p.outsideRole ? `\n另有 ${p.outsideRole} 位不在此身分組的成員也投了票` : ''),
            color: 0x57f287,
            fields: [
              { name: `✅ 已投票（${p.voted.length}）`, value: joinLimited(p.voted.map(mention), 1024) },
              { name: `❌ 未投票（${p.notVoted.length}）`, value: joinLimited(p.notVoted.map(mention), 1024) },
            ],
          },
        ],
      };
    },
    !o.public,
  );
}

function tag(c: Ctx, poll: Poll, o: Record<string, any>, cfg: GuildConfig) {
  if (!cfg.tag_role_id) return reply('請先用 `/vote-config tag-role` 設定要加給未投票者的身分組。');
  const roleId = o.role ?? poll.check_role_id ?? cfg.check_role_id;
  if (!roleId) return reply('請指定 `role`（要檢查的身分組），或先用 `/vote-config check-role` 設定預設值。');
  const tagRole = cfg.tag_role_id;
  return deferred(c, async () => {
    const { votes } = await loadPoll(c.env, poll.id);
    const { notVoted } = await computeProgress(c.env, poll, roleId, votes);
    const userIds = notVoted.map((m) => m.user.id);
    if (!userIds.length) return { content: `🎉 <@&${roleId}> 的成員都已經投票了，不需要標記。` };
    const notify = { kind: 'interaction' as const, appId: c.i.application_id, token: c.i.token };
    await pollStub(c.env, poll.id).enqueueRoleJob(newRoleJob(poll, tagRole, 'add', userIds, notify));
    const preview = joinLimited(notVoted.map(memberName), 500);
    return { content: `⏳ 正在將 ${userIds.length} 位未投票者加入 <@&${tagRole}>…\n${preview}` };
  });
}

function untag(c: Ctx, poll: Poll) {
  return deferred(c, async () => {
    const tagged = await getTagged(c.env, poll.id);
    if (!tagged.length) return { content: `投票 \`${poll.id}\` 目前沒有被標記的成員。` };
    const notify = { kind: 'interaction' as const, appId: c.i.application_id, token: c.i.token };
    const stub = pollStub(c.env, poll.id);
    // 依身分組分組（標記身分組可能中途改過）
    const byRole = new Map<string, string[]>();
    for (const t of tagged) byRole.set(t.role_id, [...(byRole.get(t.role_id) ?? []), t.user_id]);
    for (const [roleId, users] of byRole) await stub.enqueueRoleJob(newRoleJob(poll, roleId, 'remove', users, notify));
    return { content: `⏳ 正在移除 ${tagged.length} 位成員的標記身分組…` };
  });
}

