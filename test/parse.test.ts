import { describe, expect, it } from 'vitest';
import { exportRows, toCsv } from '../src/export';
import { optionsToText, parseOptions } from '../src/options';
import { formatTs, parseDeadline, zonedToUtc } from '../src/time';
import type { Poll, PollOption, Vote } from '../src/types';
import { joinLimited } from '../src/util';

const TZ = 'Asia/Taipei';
// 2026-10-27 12:00 台北時間
const NOW = Date.UTC(2026, 9, 27, 4, 0);

describe('parseDeadline', () => {
  const at = (s: string) => {
    const r = parseDeadline(s, TZ, NOW);
    if ('error' in r) throw new Error(r.error);
    return formatTs(r.at, TZ);
  };

  it('完整日期時間', () => expect(at('2026-11-01 21:00')).toBe('2026-11-01 21:00'));
  it('斜線與全形冒號', () => expect(at('2026/11/1 21：00')).toBe('2026-11-01 21:00'));
  it('省略年份', () => expect(at('11-01 21:00')).toBe('2026-11-01 21:00'));
  it('省略年份且已過 → 明年', () => expect(at('01-05 20:00')).toBe('2027-01-05 20:00'));
  it('只有日期 → 23:59', () => expect(at('11/3')).toBe('2026-11-03 23:59'));
  it('只有時間（未過）→ 今天', () => expect(at('21:00')).toBe('2026-10-27 21:00'));
  it('只有時間（已過）→ 明天', () => expect(at('09:00')).toBe('2026-10-28 09:00'));
  it('明天', () => expect(at('明天 20:30')).toBe('2026-10-28 20:30'));
  it('相對時間', () => {
    expect(at('3d')).toBe('2026-10-30 12:00');
    expect(at('1d12h')).toBe('2026-10-29 00:00');
    expect(at('90m')).toBe('2026-10-27 13:30');
  });
  it('拒絕過去、無效、太遠', () => {
    expect('error' in parseDeadline('2026-10-01 10:00', TZ, NOW)).toBe(true);
    expect('error' in parseDeadline('2026-02-31 10:00', TZ, NOW)).toBe(true);
    expect('error' in parseDeadline('隨便', TZ, NOW)).toBe(true);
    expect('error' in parseDeadline('400d', TZ, NOW)).toBe(true);
  });
  it('其他時區（含夏令時間）', () => {
    const ts = zonedToUtc({ y: 2026, mo: 7, d: 1, h: 20, mi: 0 }, 'America/Los_Angeles');
    expect(new Date(ts).toISOString()).toBe('2026-07-02T03:00:00.000Z');
  });
});

describe('parseOptions', () => {
  it('解析各種表情與請假標記', () => {
    const lookup = new Map([['suimeng', { id: '123456789012345678', animated: false }]]);
    const { options, errors } = parseOptions(
      '⚔️ 碎夢\n<a:tie:112233445566778899> 鐵衣\n:suimeng: 素問\n神相\n🛌 請假 [請假]\n事假\n1️⃣ 數字',
      lookup,
    );
    expect(errors).toEqual([]);
    expect(options.map((o) => [o.label, o.emoji_name, o.emoji_id, o.kind])).toEqual([
      ['碎夢', '⚔️', null, 'class'],
      ['鐵衣', 'tie', '112233445566778899', 'class'],
      ['素問', 'suimeng', '123456789012345678', 'class'],
      ['神相', null, null, 'class'],
      ['請假', '🛌', null, 'leave'],
      ['事假', null, null, 'class'],
      ['數字', '1️⃣', null, 'class'],
    ]);
    expect(options[1].emoji_animated).toBe(1);
  });

  it('[leave] 標記非「請假」字樣的選項，轉回文字可再解析', () => {
    const { options } = parseOptions('🏖️ 不克參加 [leave]');
    expect(options[0].kind).toBe('leave');
    expect(optionsToText(options)).toBe('🏖️ 不克參加 [請假]');
    expect(parseOptions(optionsToText(options)).options).toEqual(options);
  });

  it('錯誤：找不到表情、重複、太多', () => {
    expect(parseOptions(':nope: A').errors[0]).toContain(':nope:');
    expect(parseOptions('A\nA').errors[0]).toContain('重複');
    expect(parseOptions(Array.from({ length: 21 }, (_, i) => `O${i}`).join('\n')).errors[0]).toContain('最多');
    expect(parseOptions('\n  \n').errors[0]).toContain('至少');
  });
});

describe('export', () => {
  const poll = { id: 'K7Q2MX', title: '週六幫戰' } as Poll;
  const options = [
    { idx: 0, label: '碎夢', kind: 'class' },
    { idx: 1, label: '請假', kind: 'leave' },
  ] as PollOption[];
  const votes = [
    { user_id: '1', display_name: '千溟征', option_idx: 0, reason: null, voted_at: NOW, updated_at: NOW },
    { user_id: '2', display_name: '=HYPERLINK("x")', option_idx: 1, reason: '加班, 抱歉', voted_at: NOW, updated_at: NOW + 60_000 },
  ] as Vote[];
  const nonVoters = [{ user: { id: '3', username: 'yesheng' }, nick: '葉咲苼', roles: [] }];

  it('含投票人、選項、類型與未投票者', () => {
    const rows = exportRows(poll, options, votes, nonVoters, TZ);
    expect(rows[1].slice(3, 6)).toEqual(['千溟征', '碎夢', '流派']);
    expect(rows[2].slice(4, 7)).toEqual(['請假', '請假', '加班, 抱歉']);
    expect(rows[3].slice(3, 6)).toEqual(['葉咲苼', '（未投票）', '未投票']);
    expect(rows[1][7]).toBe('2026-10-27 12:00');
  });

  it('CSV 有 BOM、正確跳脫、防公式注入', () => {
    const csv = toCsv(exportRows(poll, options, votes, [], TZ));
    expect(csv.startsWith('﻿投票ID,')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"加班, 抱歉"');
  });
});

describe('joinLimited', () => {
  it('超過上限時顯示剩餘人數', () => {
    expect(joinLimited(['a', 'b', 'c'], 100)).toBe('a、b、c');
    expect(joinLimited(['aaaa', 'bbbb', 'cccc', 'dddd'], 16)).toBe('aaaa、bbbb…等 2 人');
    expect(joinLimited(['aaaa', 'bbbb', 'cccc', 'dddd'], 12)).toBe('aaaa…等 3 人');
    expect(joinLimited([], 10)).toBe('—');
  });
});
