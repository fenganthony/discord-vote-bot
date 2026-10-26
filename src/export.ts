import type { Member, Poll, PollOption, Vote } from './types';
import { memberName } from './discord';
import { formatTs } from './time';

export const EXPORT_HEADER = ['投票ID', '標題', '使用者ID', '名稱', '選項', '類型', '請假原因', '首次投票時間', '最後修改時間'];

/** 匯出資料列：先列已投票者，再列（若有檢查身分組）未投票者 */
export function exportRows(poll: Poll, options: PollOption[], votes: Vote[], nonVoters: Member[], tz: string): string[][] {
  const byIdx = new Map(options.map((o) => [o.idx, o]));
  const rows = votes.map((v) => {
    const o = byIdx.get(v.option_idx);
    return [
      poll.id,
      poll.title,
      v.user_id,
      v.display_name,
      o?.label ?? `(已刪除選項 ${v.option_idx})`,
      o?.kind === 'leave' ? '請假' : '流派',
      v.reason ?? '',
      formatTs(v.voted_at, tz),
      formatTs(v.updated_at, tz),
    ];
  });
  for (const m of nonVoters) rows.push([poll.id, poll.title, m.user.id, memberName(m), '（未投票）', '未投票', '', '', '']);
  return [EXPORT_HEADER, ...rows];
}

function csvCell(value: string): string {
  // 避免 Excel 把 =、+、-、@ 開頭的內容當公式執行
  const s = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 帶 BOM 的 CSV，Excel 直接開中文才不會亂碼 */
export const toCsv = (rows: string[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
