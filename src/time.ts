const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(ts: number, tz: string): Parts & { s: number } {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

function offsetAt(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/** 把某時區的「牆上時間」轉成 epoch ms */
export function zonedToUtc(p: Parts, tz: string): number {
  const guess = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatTs(ts: number, tz: string, withYear = true): string {
  const p = zonedParts(ts, tz);
  const date = withYear ? `${p.y}-${pad(p.mo)}-${pad(p.d)}` : `${pad(p.mo)}/${pad(p.d)}`;
  return `${date} ${pad(p.h)}:${pad(p.mi)}`;
}

const DAY_WORDS: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 後天: 2 };

/**
 * 支援：
 *   2026-11-01 21:00 / 2026/11/1 21:00 / 11-01 21:00 / 11/1（未給時間 = 23:59）
 *   21:00（今天，已過則明天）/ 明天 21:00
 *   3d / 12h / 90m / 1d12h（相對時間）
 */
export function parseDeadline(input: string, tz: string, now: number): { at: number } | { error: string } {
  const text = input.trim().replace(/：/g, ':').replace(/\s+/g, ' ');
  const at = parse(text, tz, now);
  if (at === null || Number.isNaN(at))
    return { error: `看不懂截止時間「${input}」，請用 2026-11-01 21:00、明天 21:00 或 3d 這類格式。` };
  if (at <= now + MINUTE) return { error: `截止時間 ${formatTs(at, tz)} 已經過了（或太近），請設定在未來。` };
  if (at > now + 366 * DAY) return { error: '截止時間不能超過一年後。' };
  return { at };
}

function parse(text: string, tz: string, now: number): number | null {
  const rel = text.toLowerCase().replace(/\s/g, '');
  if (/^(\d+(d|h|m|天|小時|分鐘?))+$/.test(rel)) {
    let ms = 0;
    for (const [, n, unit] of rel.matchAll(/(\d+)(d|h|m|天|小時|分鐘?)/g)) {
      const k = unit === 'd' || unit === '天' ? DAY : unit === 'h' || unit === '小時' ? HOUR : MINUTE;
      ms += Number(n) * k;
    }
    return now + ms;
  }

  const today = zonedParts(now, tz);

  const dayWord = text.match(/^(今天|今日|明天|明日|後天)\s*(\d{1,2}):(\d{2})$/);
  const timeOnly = text.match(/^(\d{1,2}):(\d{2})$/);
  if (dayWord || timeOnly) {
    const [h, mi] = dayWord ? [+dayWord[2], +dayWord[3]] : [+timeOnly![1], +timeOnly![2]];
    if (!validTime(h, mi)) return null;
    const base = zonedToUtc({ ...today, h, mi }, tz);
    if (dayWord) return base + DAY_WORDS[dayWord[1]] * DAY;
    return base > now ? base : base + DAY;
  }

  const m = text.match(/^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const mo = +m[2];
  const d = +m[3];
  const [h, mi] = m[4] ? [+m[4], +m[5]] : [23, 59];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || !validTime(h, mi)) return null;
  let y = m[1] ? +m[1] : today.y;
  let at = zonedToUtc({ y, mo, d, h, mi }, tz);
  if (!m[1] && at <= now) at = zonedToUtc({ y: ++y, mo, d, h, mi }, tz);
  // 防止 2/31 之類被 Date 進位成別的日子
  const check = zonedParts(at, tz);
  if (check.mo !== mo || check.d !== d) return null;
  return at;
}

const validTime = (h: number, mi: number) => h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
