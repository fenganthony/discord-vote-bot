import type { Poll, PollOption, Vote } from './types';
import { joinLimited, truncate, unix } from './util';

const COLOR_OPEN = 0x5865f2;
const COLOR_CLOSED = 0x99aab5;

export function emojiText(o: PollOption): string {
  if (o.emoji_id) return `<${o.emoji_animated ? 'a' : ''}:${o.emoji_name}:${o.emoji_id}>`;
  return o.emoji_name ?? '';
}

export const optionText = (o: PollOption) => (emojiText(o) ? `${emojiText(o)} ${o.label}` : o.label);

function buttonEmoji(o: PollOption) {
  if (o.emoji_id) return { id: o.emoji_id, name: o.emoji_name, animated: !!o.emoji_animated };
  if (o.emoji_name) return { name: o.emoji_name };
  return undefined;
}

export function tally(options: PollOption[], votes: Vote[]): Map<number, number> {
  const counts = new Map(options.map((o) => [o.idx, 0]));
  for (const v of votes) counts.set(v.option_idx, (counts.get(v.option_idx) ?? 0) + 1);
  return counts;
}

export const countLines = (options: PollOption[], counts: Map<number, number>) =>
  options.map((o) => `${optionText(o)}　**${counts.get(o.idx) ?? 0}**`).join('\n');

/** 頻道裡那則投票訊息（embed + 按鈕） */
export function renderPoll(poll: Poll, options: PollOption[], counts: Map<number, number>) {
  const closed = poll.status === 'closed';
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const t = unix(poll.deadline_at);
  const embed = {
    title: truncate((closed ? '🔒 ' : '') + poll.title, 256),
    description: poll.content ? truncate(poll.content, 4000) : undefined,
    color: closed ? COLOR_CLOSED : COLOR_OPEN,
    fields: [
      { name: closed ? '⏰ 已截止' : '⏰ 截止時間', value: `<t:${t}:F>（<t:${t}:R>）` },
      { name: closed ? '📊 最終結果' : '📊 目前統計', value: truncate(countLines(options, counts), 1024) },
    ],
    footer: { text: `投票 ID：${poll.id}・共 ${total} 票${closed ? '' : '・再點其他選項即可改票'}` },
  };

  const rows: unknown[] = [];
  for (let i = 0; i < options.length; i += 5) {
    rows.push({
      type: 1,
      components: options.slice(i, i + 5).map((o) => ({
        type: 2,
        style: o.kind === 'leave' ? 2 : 1,
        label: truncate(o.label, 80),
        emoji: buttonEmoji(o),
        custom_id: `v:${poll.id}:${o.idx}`,
        disabled: closed,
      })),
    });
  }
  rows.push({
    type: 1,
    components: [
      { type: 2, style: 2, label: '我的投票 / 分布', emoji: { name: '📊' }, custom_id: `s:${poll.id}` },
      { type: 2, style: 2, label: '撤回投票', emoji: { name: '↩️' }, custom_id: `w:${poll.id}`, disabled: closed },
    ],
  });

  return { embeds: [embed], components: rows };
}

/** 管理員用：各選項的人數與名單 */
export function renderStatus(poll: Poll, options: PollOption[], votes: Vote[]) {
  const byOption = new Map<number, Vote[]>(options.map((o) => [o.idx, []]));
  for (const v of votes) byOption.get(v.option_idx)?.push(v);
  const t = unix(poll.deadline_at);
  return {
    title: truncate(`📊 ${poll.title}`, 256),
    description: `ID \`${poll.id}\`・${poll.status === 'open' ? '🟢 進行中' : '🔒 已截止'}・截止 <t:${t}:f>・共 **${votes.length}** 票`,
    color: poll.status === 'open' ? COLOR_OPEN : COLOR_CLOSED,
    fields: options.slice(0, 25).map((o) => {
      const list = byOption.get(o.idx) ?? [];
      const names = list.map((v) => (v.reason ? `<@${v.user_id}>（${truncate(v.reason, 40)}）` : `<@${v.user_id}>`));
      return { name: truncate(`${optionText(o)} — ${list.length} 人`, 256), value: joinLimited(names, 1024) };
    }),
  };
}
