import type { Ctx, Poll, PollOption, Vote } from '../types';
import { deletePollRows, deleteVote, getOptions, getPoll, getVote, getVotes, upsertVote } from '../db';
import { deleteMessage, DiscordError } from '../discord';
import { afterVote, pollStub } from '../poll-service';
import { countLines, optionText, tally } from '../render';
import { displayNameOf, findPoll, isManager, json, modal, NOT_MANAGER, reply, userOf } from '../respond';
import { unix } from '../util';

export async function handleComponent(c: Ctx): Promise<Response> {
  const [kind, pollId, arg] = String(c.i.data.custom_id).split(':');
  switch (kind) {
    case 'v':
      return vote(c, pollId, Number(arg));
    case 's':
      return showMine(c, pollId);
    case 'w':
      return withdraw(c, pollId);
    case 'del':
      return confirmDelete(c, pollId);
    case 'delx':
      return json({ type: 7, data: { content: '已取消刪除。', components: [] } });
  }
  return reply('未知的操作。');
}

/** 取得仍可投票的投票，否則回傳錯誤回覆 */
export async function openPoll(c: Ctx, pollId: string): Promise<{ poll: Poll; options: PollOption[] } | Response> {
  const poll = await getPoll(c.env, pollId);
  if (!poll) return reply('這個投票已經被刪除了。');
  if (poll.status !== 'open' || poll.deadline_at <= Date.now()) return reply('🔒 投票已截止，無法再投票或改票。');
  return { poll, options: await getOptions(c.env, pollId) };
}

async function vote(c: Ctx, pollId: string, idx: number) {
  const r = await openPoll(c, pollId);
  if (r instanceof Response) return r;
  const opt = r.options.find((o) => o.idx === idx);
  if (!opt) return reply('這個選項已不存在。');
  const existing = await getVote(c.env, pollId, userOf(c.i).id);

  if (opt.kind === 'leave') {
    return modal(`lr:${pollId}:${idx}`, '請假', [
      {
        custom_id: 'reason',
        label: '請假原因（可留空）',
        style: 2,
        required: false,
        max_length: 300,
        value: existing?.option_idx === idx ? (existing.reason ?? undefined) : undefined,
      },
    ]);
  }
  if (existing?.option_idx === idx) return reply(`你已經投給 ${optionText(opt)} 了 👍`);
  return castVote(c, r.poll, r.options, opt, existing, null);
}

export async function castVote(c: Ctx, poll: Poll, options: PollOption[], opt: PollOption, existing: Vote | null, reason: string | null) {
  const now = Date.now();
  const userId = userOf(c.i).id;
  await upsertVote(c.env, {
    poll_id: poll.id,
    user_id: userId,
    option_idx: opt.idx,
    display_name: displayNameOf(c.i),
    reason,
    voted_at: existing?.voted_at ?? now,
    updated_at: now,
  });
  c.ctx.waitUntil(afterVote(c.env, poll, userId).catch((e) => console.error('afterVote', e)));

  const prev = existing && options.find((o) => o.idx === existing.option_idx);
  let msg = `✅ 已投給 ${optionText(opt)}`;
  if (existing && existing.option_idx === opt.idx) msg = `📝 已更新：${optionText(opt)}`;
  else if (prev) msg = `🔄 已從 ${optionText(prev)} 改為 ${optionText(opt)}`;
  if (reason) msg += `（${reason}）`;
  return reply(`${msg}\n截止 <t:${unix(poll.deadline_at)}:R>，截止前都可以再點其他選項改票。`);
}

async function showMine(c: Ctx, pollId: string) {
  const poll = await getPoll(c.env, pollId);
  if (!poll) return reply('這個投票已經被刪除了。');
  const [options, votes] = await Promise.all([getOptions(c.env, pollId), getVotes(c.env, pollId)]);
  const mine = votes.find((v) => v.user_id === userOf(c.i).id);
  const myOpt = mine && options.find((o) => o.idx === mine.option_idx);
  const me = myOpt ? `你目前選擇：**${optionText(myOpt)}**${mine?.reason ? `（${mine.reason}）` : ''}` : '你還沒有投票。';
  return reply(`${me}\n\n**目前分布**（共 ${votes.length} 票）\n${countLines(options, tally(options, votes))}`);
}

async function withdraw(c: Ctx, pollId: string) {
  const r = await openPoll(c, pollId);
  if (r instanceof Response) return r;
  if (!(await deleteVote(c.env, pollId, userOf(c.i).id))) return reply('你還沒有投票。');
  c.ctx.waitUntil(pollStub(c.env, pollId).requestRefresh(pollId));
  return reply('↩️ 已撤回你的投票。');
}

async function confirmDelete(c: Ctx, pollId: string) {
  if (!(await isManager(c.env, c.i))) return reply(NOT_MANAGER);
  const poll = await findPoll(c.env, c.i.guild_id, pollId);
  if (!poll) return json({ type: 7, data: { content: '這個投票已經不存在了。', components: [] } });
  let note = '';
  if (poll.message_id) {
    await deleteMessage(c.env, poll.channel_id, poll.message_id).catch((e) => {
      if (!(e instanceof DiscordError && e.status === 404)) note = '\n⚠️ 頻道中的投票訊息刪除失敗，請手動刪除。';
    });
  }
  await deletePollRows(c.env, poll.id);
  await pollStub(c.env, poll.id).clear();
  return json({ type: 7, data: { content: `🗑️ 已刪除投票 \`${poll.id}\`「${poll.title}」。${note}`, components: [] } });
}
