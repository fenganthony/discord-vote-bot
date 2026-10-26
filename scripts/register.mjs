// 註冊斜線指令。用法：
//   DISCORD_TOKEN=xxx DISCORD_APP_ID=yyy [GUILD_ID=zzz] node scripts/register.mjs
// 有 GUILD_ID 時註冊為伺服器指令（立即生效，適合測試）；否則註冊為全域指令。

const { DISCORD_TOKEN, DISCORD_APP_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_APP_ID) {
  console.error('請設定 DISCORD_TOKEN 與 DISCORD_APP_ID 環境變數');
  process.exit(1);
}

const SUB = 1, STRING = 3, BOOLEAN = 5, CHANNEL = 7, ROLE = 8, ATTACHMENT = 11;
const id = { type: STRING, name: 'id', description: '投票 ID（可輸入標題搜尋）', required: true, autocomplete: true };
const guildOnly = { contexts: [0], integration_types: [0] };

const commands = [
  {
    name: 'vote',
    description: '投票管理',
    ...guildOnly,
    options: [
      {
        type: SUB, name: 'create', description: '發布新投票（送出後會跳出表單填標題、內容、選項、截止時間）',
        options: [
          { type: ATTACHMENT, name: 'image', description: '投票圖片' },
          { type: CHANNEL, name: 'channel', description: '發布到哪個頻道（預設為目前頻道）', channel_types: [0, 5] },
          { type: STRING, name: 'template', description: '套用選項範本', autocomplete: true },
          { type: ROLE, name: 'check_role', description: '這次投票要檢查的身分組（覆寫伺服器預設）' },
        ],
      },
      { type: SUB, name: 'close', description: '立即截止投票', options: [id] },
      {
        type: SUB, name: 'edit', description: '修改截止時間 / 標題 / 內容（已截止的投票延後截止會重新開放）',
        options: [
          id,
          { type: STRING, name: 'deadline', description: '新截止時間，如 2026-11-01 21:00、明天 21:00、3d' },
          { type: STRING, name: 'title', description: '新標題' },
          { type: STRING, name: 'content', description: '新內容（\\n 換行）' },
        ],
      },
      { type: SUB, name: 'status', description: '顯示目前投票分布與名單', options: [id, { type: BOOLEAN, name: 'public', description: '公開顯示在頻道（預設只有你看得到）' }] },
      {
        type: SUB, name: 'export', description: '匯出投票結果',
        options: [id, { type: STRING, name: 'format', description: '格式（預設 CSV）', choices: [{ name: 'CSV 檔案', value: 'csv' }, { name: 'Google 試算表', value: 'sheets' }] }],
      },
      {
        type: SUB, name: 'list', description: '列出投票',
        options: [{ type: STRING, name: 'status', description: '篩選狀態', choices: [{ name: '進行中', value: 'open' }, { name: '已截止', value: 'closed' }, { name: '全部', value: 'all' }] }],
      },
      { type: SUB, name: 'delete', description: '刪除投票（含頻道訊息與所有選票）', options: [id] },
      {
        type: SUB, name: 'progress', description: '身分組投票進度：已投票 / 未投票名單',
        options: [id, { type: ROLE, name: 'role', description: '要檢查的身分組（預設用設定值）' }, { type: BOOLEAN, name: 'public', description: '公開顯示在頻道' }],
      },
      { type: SUB, name: 'tag', description: '把未投票者加入標記身分組', options: [id, { type: ROLE, name: 'role', description: '要檢查的身分組（預設用設定值）' }] },
      { type: SUB, name: 'untag', description: '移除這個投票加上的標記身分組', options: [id] },
    ],
  },
  {
    name: 'vote-config',
    description: '投票 bot 伺服器設定',
    default_member_permissions: String(1 << 5), // 管理伺服器
    ...guildOnly,
    options: [
      { type: SUB, name: 'show', description: '查看目前設定' },
      { type: SUB, name: 'check-role', description: '設定預設檢查是否投票的身分組（留空 = 清除）', options: [{ type: ROLE, name: 'role', description: '身分組' }] },
      {
        type: SUB, name: 'tag-role', description: '設定未投票者標記身分組與自動標記（都留空 = 清除）',
        options: [{ type: ROLE, name: 'role', description: '標記身分組' }, { type: BOOLEAN, name: 'auto', description: '投票截止時自動標記未投票者' }],
      },
      { type: SUB, name: 'admin-role', description: '設定可管理投票的身分組（留空 = 清除）', options: [{ type: ROLE, name: 'role', description: '身分組' }] },
      { type: SUB, name: 'timezone', description: '設定時區（預設 Asia/Taipei）', options: [{ type: STRING, name: 'tz', description: 'IANA 時區，如 Asia/Taipei', required: true }] },
      { type: SUB, name: 'sheet', description: '設定 Google 試算表（貼網址，留空 = 清除）', options: [{ type: STRING, name: 'spreadsheet', description: '試算表網址或 ID' }] },
    ],
  },
  {
    name: 'vote-template',
    description: '選項範本（例如固定的流派 + 請假清單）',
    ...guildOnly,
    options: [
      { type: SUB, name: 'save', description: '新增或修改範本', options: [{ type: STRING, name: 'name', description: '範本名稱', required: true, max_length: 40 }] },
      { type: SUB, name: 'list', description: '列出範本' },
      { type: SUB, name: 'delete', description: '刪除範本', options: [{ type: STRING, name: 'name', description: '範本名稱', required: true, autocomplete: true }] },
    ],
  },
];

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/commands`;

const res = await fetch(url, {
  method: 'PUT',
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});
if (!res.ok) {
  console.error('註冊失敗', res.status, await res.text());
  process.exit(1);
}
console.log(`✅ 已註冊 ${commands.length} 個指令${GUILD_ID ? `到伺服器 ${GUILD_ID}` : '（全域，可能需要數分鐘生效）'}`);
