import type { OptionKind } from './types';

export const MAX_OPTIONS = 20; // 4 列 × 5 顆，最後一列留給「查看 / 撤回」
export const DEFAULT_OPTIONS_TEXT = '⚔️ 流派A\n🛡️ 流派B\n🛌 請假 [請假]';

export interface ParsedOption {
  label: string;
  emoji_id: string | null;
  emoji_name: string | null;
  emoji_animated: number;
  kind: OptionKind;
}

export type EmojiLookup = Map<string, { id: string; animated: boolean }>;

const LEAVE_TAG = /\s*[\[【(（](請假|leave)[\]】)）]\s*$/i;
const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{15,21})>\s*/;
const SHORTCODE = /^:(\w{2,32}):\s*/;
const segmenter = new Intl.Segmenter();

/** 選項文字是否用到 :name: 形式的伺服器表情（需要先抓伺服器表情清單） */
export const needsEmojiLookup = (text: string) => /(^|\n)\s*:\w{2,32}:/.test(text);

/**
 * 一行一個選項：
 *   ⚔️ 碎夢            一般 emoji
 *   <:suimeng:1234> 碎夢  伺服器表情（在 Discord 輸入 \:suimeng: 可取得這串）
 *   :suimeng: 碎夢      伺服器表情短碼（自動對照）
 *   🛌 請假 [請假]       加上 [請假] / [leave] 標記為請假類；標籤含「請假」也會自動判定
 */
export function parseOptions(text: string, lookup?: EmojiLookup): { options: ParsedOption[]; errors: string[] } {
  const options: ParsedOption[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((raw, n) => {
    let line = raw.trim();
    if (!line) return;
    const lineNo = `第 ${n + 1} 行`;

    let kind: OptionKind = 'class';
    if (LEAVE_TAG.test(line)) {
      kind = 'leave';
      line = line.replace(LEAVE_TAG, '');
    }

    let emoji: Pick<ParsedOption, 'emoji_id' | 'emoji_name' | 'emoji_animated'> = {
      emoji_id: null,
      emoji_name: null,
      emoji_animated: 0,
    };
    let m: RegExpMatchArray | null;
    if ((m = line.match(CUSTOM_EMOJI))) {
      emoji = { emoji_id: m[3], emoji_name: m[2], emoji_animated: m[1] ? 1 : 0 };
      line = line.slice(m[0].length);
    } else if ((m = line.match(SHORTCODE))) {
      const found = lookup?.get(m[1]);
      if (!found) {
        errors.push(`${lineNo}：伺服器裡找不到表情 :${m[1]}:`);
        return;
      }
      emoji = { emoji_id: found.id, emoji_name: m[1], emoji_animated: found.animated ? 1 : 0 };
      line = line.slice(m[0].length);
    } else {
      const first = segmenter.segment(line)[Symbol.iterator]().next().value?.segment;
      if (first && /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(first)) {
        emoji = { emoji_id: null, emoji_name: first, emoji_animated: 0 };
        line = line.slice(first.length);
      }
    }

    const label = line.trim();
    if (!label) {
      errors.push(`${lineNo}：缺少選項名稱`);
      return;
    }
    if (label.length > 80) {
      errors.push(`${lineNo}：選項名稱超過 80 字`);
      return;
    }
    if (seen.has(label)) {
      errors.push(`${lineNo}：選項「${label}」重複了`);
      return;
    }
    seen.add(label);
    if (kind === 'class' && label.includes('請假')) kind = 'leave';
    options.push({ label, ...emoji, kind });
  });

  if (!options.length && !errors.length) errors.push('至少需要 1 個選項');
  if (options.length > MAX_OPTIONS) errors.push(`最多 ${MAX_OPTIONS} 個選項（目前 ${options.length} 個）`);
  return { options, errors };
}

/** 把選項轉回可編輯的文字（存範本 / 預填 Modal 用） */
export function optionsToText(options: ParsedOption[]): string {
  return options
    .map((o) => {
      const emoji = o.emoji_id ? `<${o.emoji_animated ? 'a' : ''}:${o.emoji_name}:${o.emoji_id}> ` : o.emoji_name ? `${o.emoji_name} ` : '';
      const tag = o.kind === 'leave' && !o.label.includes('請假') ? ' [請假]' : '';
      return emoji + o.label + tag;
    })
    .join('\n');
}
