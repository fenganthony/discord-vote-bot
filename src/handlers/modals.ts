import type { Ctx, MessagePayload, Poll, PollOption } from '../types';
import { deletePollRows, getConfig, getVote, insertPoll, pollIdExists, saveTemplate, takePending, updatePoll } from '../db';
import { guildEmojis, sendMessage } from '../discord';
import { needsEmojiLookup, optionsToText, parseOptions, type EmojiLookup } from '../options';
import { pollStub } from '../poll-service';
import { renderPoll } from '../render';
import { deferred, isManager, modalFields, NOT_MANAGER, reply, userOf } from '../respond';
import { parseDeadline } from '../time';
import { newPollId, unix } from '../util';
import { castVote, openPoll } from './components';
import type { PendingCreate } from './vote';

export async function handleModal(c: Ctx): Promise<Response> {
  const id = String(c.i.data.custom_id);
  const sep = id.indexOf(':');
  const kind = id.slice(0, sep);
  const rest = id.slice(sep + 1);
  const f = modalFields(c.i.data.components);

  if (kind === 'c') return deferred(c, () => finishCreate(c, rest, f));

  if (kind === 'lr') {
    const [pollId, idx] = rest.split(':');
    const r = await openPoll(c, pollId);
    if (r instanceof Response) return r;
    const opt = r.options.find((o) => o.idx === Number(idx));
    if (!opt) return reply('這個選項已不存在。');
    const existing = await getVote(c.env, pollId, userOf(c.i).id);
    return castVote(c, r.poll, r.options, opt, existing, f.reason?.trim() || null);
  }

  if (kind === 't') {
    if (!(await isManager(c.env, c.i))) return reply(NOT_MANAGER);
    const lookup = needsEmojiLookup(f.options) ? await emojiLookup(c) : undefined;
    const parsed = parseOptions(f.options, lookup);
    if (parsed.errors.length) return reply(`❌ 範本有問題：\n${parsed.errors.map((e) => `・${e}`).join('\n')}${echo(f.options)}`);
    await saveTemplate(c.env, c.i.guild_id, rest, optionsToText(parsed.options));
    return reply(`💾 已儲存選項範本「${rest}」（${parsed.options.length} 個選項），建立投票時用 \`template:${rest}\` 套用。`);
  }

  return reply('未知的表單。');
}

const echo = (text: string) => `\n\n你填的選項（可複製重用）：\n\`\`\`\n${text.replace(/```/g, '')}\n\`\`\``;

async function emojiLookup(c: Ctx): Promise<EmojiLookup> {
  const list = await guildEmojis(c.env, c.i.guild_id);
  return new Map(list.map((e) => [e.name, { id: e.id, animated: !!e.animated }]));
}

async function finishCreate(c: Ctx, nonce: string, f: Record<string, string>): Promise<MessagePayload> {
  const pending = await takePending<PendingCreate>(c.env, nonce);
  if (!pending) return { content: `⌛ 建立逾時，請重新執行 \`/vote create\`。${echo(f.options)}` };

  const cfg = await getConfig(c.env, c.i.guild_id);
  const now = Date.now();
  const d = parseDeadline(f.deadline ?? '', cfg.timezone, now);
  if ('error' in d) return { content: `❌ ${d.error}${echo(f.options)}` };

  const lookup = needsEmojiLookup(f.options) ? await emojiLookup(c) : undefined;
  const parsed = parseOptions(f.options, lookup);
  if (parsed.errors.length) return { content: `❌ 選項有問題：\n${parsed.errors.map((e) => `・${e}`).join('\n')}${echo(f.options)}` };

  let id = newPollId();
  while (await pollIdExists(c.env, id)) id = newPollId();

  const poll: Poll = {
    id,
    guild_id: c.i.guild_id,
    channel_id: pending.channelId,
    message_id: null,
    title: f.title.trim(),
    content: (f.content ?? '').trim(),
    status: 'open',
    deadline_at: d.at,
    check_role_id: pending.checkRoleId,
    created_by: userOf(c.i).id,
    created_at: now,
    closed_at: null,
  };
  const options: PollOption[] = parsed.options.map((o, idx) => ({ poll_id: id, idx, ...o }));
  await insertPoll(c.env, poll, options);

  // 圖片以附件形式重新上傳：Discord CDN 連結會過期，附件則由 Discord 自動續期
  const files = [];
  let imageNote = '';
  if (pending.image) {
    try {
      const res = await fetch(pending.image.url);
      if (!res.ok) throw new Error(String(res.status));
      const ext = pending.image.contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      files.push({ name: `poll-${id}.${ext}`, data: await res.blob() });
    } catch {
      imageNote = '\n⚠️ 圖片下載失敗，投票已發布但沒有附圖。';
    }
  }

  let messageId: string;
  try {
    const msg = await sendMessage(c.env, poll.channel_id, { ...renderPoll(poll, options, new Map()), files });
    messageId = msg.id;
  } catch (e) {
    await deletePollRows(c.env, id);
    throw e;
  }
  await updatePoll(c.env, id, { message_id: messageId });
  await pollStub(c.env, id).setDeadline(id, d.at);

  return {
    content:
      `✅ 已發布投票 **${poll.title}**\n` +
      `ID：\`${id}\`・截止 <t:${unix(d.at)}:F>（<t:${unix(d.at)}:R>）\n` +
      `🔗 https://discord.com/channels/${poll.guild_id}/${poll.channel_id}/${messageId}${imageNote}`,
  };
}
