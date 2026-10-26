import type { Env, Member, Poll, RoleJob, Vote, JobNotify } from './types';
import { addTagged, getConfig, getTaggedUser, loadPoll, markClosed, removeTagged } from './db';
import { addRole, api, DiscordError, editMessage, explainError, listMembers, removeRole, sendMessage } from './discord';
import { countLines, renderPoll, tally } from './render';

export const pollStub = (env: Env, pollId: string) => env.POLL_DO.get(env.POLL_DO.idFromName(pollId));

/** 依資料庫重畫頻道裡的投票訊息 */
export async function refreshMessage(env: Env, pollId: string) {
  const { poll, options, votes } = await loadPoll(env, pollId);
  if (!poll?.message_id) return;
  await editMessage(env, poll.channel_id, poll.message_id, renderPoll(poll, options, tally(options, votes)));
}

/**
 * 截止投票：更新訊息、回覆結果摘要；若伺服器開啟自動標記，回傳要交給 Durable Object 執行的加身分組工作。
 * 呼叫端負責把 job 排進 DO（避免 DO 在 alarm 內呼叫自己的 stub）。
 */
export async function closePoll(env: Env, pollId: string): Promise<{ closed: boolean; job?: RoleJob }> {
  if (!(await markClosed(env, pollId, Date.now()))) return { closed: false };
  const { poll, options, votes } = await loadPoll(env, pollId);
  if (!poll) return { closed: true };
  const counts = tally(options, votes);

  if (poll.message_id) {
    await editMessage(env, poll.channel_id, poll.message_id, renderPoll(poll, options, counts)).catch((e) => console.error('edit on close', e));
    await sendMessage(env, poll.channel_id, {
      content: `🔒 **${poll.title}** 已截止（ID \`${poll.id}\`），共 ${votes.length} 票\n${countLines(options, counts)}`,
      message_reference: { message_id: poll.message_id, fail_if_not_exists: false },
    }).catch((e) => console.error('summary on close', e));
  }

  const cfg = await getConfig(env, poll.guild_id);
  const checkRole = poll.check_role_id ?? cfg.check_role_id;
  if (!cfg.auto_tag || !cfg.tag_role_id || !checkRole) return { closed: true };
  let notVoted: Member[];
  try {
    notVoted = (await computeProgress(env, poll, checkRole, votes)).notVoted;
  } catch (e) {
    console.error('auto tag progress failed', e);
    await sendMessage(env, poll.channel_id, { content: `⚠️ 投票 \`${poll.id}\` 自動標記未投票者失敗：${explainError(e)}` }).catch(() => {});
    return { closed: true };
  }
  if (!notVoted.length) return { closed: true };
  return {
    closed: true,
    job: newRoleJob(poll, cfg.tag_role_id, 'add', notVoted.map((m) => m.user.id), { kind: 'channel', channelId: poll.channel_id }),
  };
}

export function newRoleJob(poll: Poll, roleId: string, mode: RoleJob['mode'], userIds: string[], notify: JobNotify | null): RoleJob {
  return { pollId: poll.id, guildId: poll.guild_id, roleId, mode, userIds, cursor: 0, ok: 0, failed: [], notify };
}

/** 9-2：某身分組裡誰投了、誰沒投（roleId = 伺服器 ID 代表 @everyone） */
export async function computeProgress(env: Env, poll: Poll, roleId: string, votes: Vote[]) {
  const members = (await listMembers(env, poll.guild_id)).filter(
    (m) => !m.user.bot && (roleId === poll.guild_id || m.roles.includes(roleId)),
  );
  const voters = new Set(votes.map((v) => v.user_id));
  const memberIds = new Set(members.map((m) => m.user.id));
  const voted: Member[] = [];
  const notVoted: Member[] = [];
  for (const m of members) (voters.has(m.user.id) ? voted : notVoted).push(m);
  const outsideRole = votes.filter((v) => !memberIds.has(v.user_id)).length;
  return { members, voted, notVoted, outsideRole };
}

/** 跑一批加 / 移除身分組，回傳整個工作是否完成 */
export async function runRoleJob(env: Env, job: RoleJob, batch: number): Promise<boolean> {
  const slice = job.userIds.slice(job.cursor, job.cursor + batch);
  const ok: string[] = [];
  const reason = `投票 ${job.pollId} ${job.mode === 'add' ? '未投票標記' : '移除未投票標記'}`;
  for (const uid of slice) {
    try {
      if (job.mode === 'add') await addRole(env, job.guildId, uid, job.roleId, reason);
      else await removeRole(env, job.guildId, uid, job.roleId, reason);
      ok.push(uid);
    } catch (e) {
      job.failed.push({ id: uid, status: e instanceof DiscordError ? e.status : 0 });
    }
  }
  job.cursor += slice.length;
  job.ok += ok.length;
  if (job.mode === 'add') await addTagged(env, job.pollId, job.roleId, ok);
  else await removeTagged(env, job.pollId, slice);
  return job.cursor >= job.userIds.length;
}

export async function notifyRoleJob(env: Env, job: RoleJob) {
  if (!job.notify) return;
  let text =
    job.mode === 'add'
      ? `🏷️ 已將 **${job.ok}** 位未投票者加入 <@&${job.roleId}>（投票 \`${job.pollId}\`）`
      : `🧹 已從 **${job.ok}** 位成員移除 <@&${job.roleId}>（投票 \`${job.pollId}\`）`;
  if (job.failed.length) {
    const forbidden = job.failed.some((f) => f.status === 403);
    text += `\n⚠️ ${job.failed.length} 位失敗` + (forbidden ? '：請確認 bot 有「管理身分組」權限，且 bot 的身分組排在該身分組之上。' : '（可能已離開伺服器）。');
  }
  if (job.notify.kind === 'interaction') {
    await api(env, 'PATCH', `/webhooks/${job.notify.appId}/${job.notify.token}/messages/@original`, {
      body: { content: text, allowed_mentions: { parse: [] } },
      auth: false,
    });
  } else {
    await sendMessage(env, job.notify.channelId, { content: text });
  }
}

/** 投票後：排程刷新訊息；若此人之前被標記為未投票，順手移除標記 */
export async function afterVote(env: Env, poll: Poll, userId: string) {
  await pollStub(env, poll.id).requestRefresh(poll.id);
  const tagged = await getTaggedUser(env, poll.id, userId);
  if (tagged) {
    await removeRole(env, poll.guild_id, userId, tagged.role_id, `投票 ${poll.id} 已補投`).catch(() => {});
    await removeTagged(env, poll.id, [userId]);
  }
}
