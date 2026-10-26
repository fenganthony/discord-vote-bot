const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 去掉 0/O、1/I/L 等易混淆字元

export function newPollId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export const normalizeId = (id: unknown) => String(id ?? '').trim().toUpperCase();

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 串接名單直到超過長度上限，剩下的以「…等 N 人」表示 */
export function joinLimited(items: string[], limit: number, sep = '、'): string {
  if (!items.length) return '—';
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const next = out ? out + sep + items[i] : items[i];
    const suffix = i < items.length - 1 ? `…等 ${items.length - i - 1} 人` : '';
    if (next.length + suffix.length > limit) return `${out}…等 ${items.length - i} 人`;
    out = next;
  }
  return out;
}

export const unix = (ms: number) => Math.floor(ms / 1000);
