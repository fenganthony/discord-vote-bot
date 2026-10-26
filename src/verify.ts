const encoder = new TextEncoder();
let cached: { hex: string; key: CryptoKey } | null = null;

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 驗證 Discord 的 Ed25519 簽章，成功時回傳 request body，失敗回傳 null。 */
export async function verifyRequest(req: Request, publicKey: string): Promise<string | null> {
  const signature = req.headers.get('X-Signature-Ed25519');
  const timestamp = req.headers.get('X-Signature-Timestamp');
  const body = await req.text();
  if (!signature || !timestamp) return null;
  if (!cached || cached.hex !== publicKey) {
    const key = await crypto.subtle.importKey('raw', fromHex(publicKey), { name: 'Ed25519' }, false, ['verify']);
    cached = { hex: publicKey, key };
  }
  const sig = fromHex(signature);
  if (sig.length !== 64) return null;
  const ok = await crypto.subtle.verify('Ed25519', cached.key, sig, encoder.encode(timestamp + body));
  return ok ? body : null;
}
