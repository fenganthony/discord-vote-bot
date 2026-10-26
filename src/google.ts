import type { Env } from './types';

let token: { value: string; exp: number } | null = null;

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const sheetsConfigured = (env: Env) => !!(env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_KEY);

/** 用 service account 換 access token（JWT RS256，Workers 內建 WebCrypto 即可簽） */
async function accessToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.exp > now + 60) return token.value;

  const pem = env.GOOGLE_SA_KEY!.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const unsigned =
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) +
    '.' +
    b64url(
      JSON.stringify({
        iss: env.GOOGLE_SA_EMAIL,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`Google 授權失敗：${res.status} ${await res.text()}`);
  const j: any = await res.json();
  token = { value: j.access_token, exp: now + j.expires_in };
  return token.value;
}

async function gapi(env: Env, method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(env)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 403 || res.status === 404)
    throw new Error(`無法存取試算表（${res.status}）。請把試算表以「編輯者」分享給 ${env.GOOGLE_SA_EMAIL}`);
  if (!res.ok) throw new Error(`Google Sheets 錯誤：${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<any>;
}

/** 每個投票一個分頁（以投票 ID 開頭），每次匯出覆寫整個分頁 */
export async function writePollSheet(env: Env, spreadsheetId: string, pollId: string, title: string, rows: string[][]) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const meta = await gapi(env, 'GET', `${base}?fields=sheets.properties(sheetId,title)`);
  const sheets: { sheetId: number; title: string }[] = meta.sheets.map((s: any) => s.properties);
  let sheet = sheets.find((s) => s.title === pollId || s.title.startsWith(`${pollId} `));
  if (!sheet) {
    const tabTitle = `${pollId} ${title.replace(/[[\]*?:/\\']/g, '')}`.slice(0, 90).trim();
    const r = await gapi(env, 'POST', `${base}:batchUpdate`, { requests: [{ addSheet: { properties: { title: tabTitle } } }] });
    sheet = r.replies[0].addSheet.properties as { sheetId: number; title: string };
  }
  const range = encodeURIComponent(`'${sheet.title}'`);
  await gapi(env, 'POST', `${base}/values/${range}:clear`, {});
  await gapi(env, 'PUT', `${base}/values/${range}!A1?valueInputOption=RAW`, { values: rows });
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheet.sheetId}`;
}
