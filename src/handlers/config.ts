import type { Ctx } from '../types';
import { deleteTemplate, getConfig, getTemplate, listTemplates, updateConfig } from '../db';
import { sheetsConfigured } from '../google';
import { DEFAULT_OPTIONS_TEXT } from '../options';
import { isManager, modal, NOT_MANAGER, reply, subcommand } from '../respond';
import { isValidTimeZone } from '../time';
import { truncate } from '../util';

const roleText = (id: string | null) => (id ? `<@&${id}>` : '（未設定）');

export async function handleConfig(c: Ctx): Promise<Response> {
  const { name, o } = subcommand(c.i);
  const guildId = c.i.guild_id;
  const cfg = await getConfig(c.env, guildId);
  if (!(await isManager(c.env, c.i, cfg))) return reply(NOT_MANAGER);

  switch (name) {
    case 'show': {
      const sheet = cfg.sheet_id ? `https://docs.google.com/spreadsheets/d/${cfg.sheet_id}` : '（未設定）';
      return reply('', {
        embeds: [
          {
            title: '⚙️ 投票設定',
            color: 0x5865f2,
            fields: [
              { name: '投票管理員身分組', value: roleText(cfg.admin_role_id), inline: true },
              { name: '檢查投票的身分組', value: roleText(cfg.check_role_id), inline: true },
              { name: '未投票標記身分組', value: roleText(cfg.tag_role_id), inline: true },
              { name: '截止時自動標記', value: cfg.auto_tag ? '✅ 開啟' : '❌ 關閉', inline: true },
              { name: '時區', value: cfg.timezone, inline: true },
              { name: 'Google 試算表', value: sheet },
            ],
          },
        ],
      });
    }
    case 'check-role':
      await updateConfig(c.env, guildId, { check_role_id: o.role ?? null });
      return reply(o.role ? `✅ 預設檢查身分組設為 <@&${o.role}>` : '✅ 已清除預設檢查身分組');
    case 'tag-role': {
      if (o.role === undefined && o.auto === undefined) {
        await updateConfig(c.env, guildId, { tag_role_id: null, auto_tag: 0 });
        return reply('✅ 已清除標記身分組並關閉自動標記');
      }
      const next = await updateConfig(c.env, guildId, {
        tag_role_id: o.role ?? cfg.tag_role_id,
        auto_tag: o.auto === undefined ? cfg.auto_tag : o.auto ? 1 : 0,
      });
      const warn = next.auto_tag && !next.check_role_id ? '\n⚠️ 自動標記需要先設定 `/vote-config check-role`（或建立投票時指定 check_role）。' : '';
      return reply(
        `✅ 未投票標記身分組：${roleText(next.tag_role_id)}・截止時自動標記：${next.auto_tag ? '開啟' : '關閉'}${warn}\n` +
          '提醒：bot 的身分組必須排在標記身分組之上，並有「管理身分組」權限。',
      );
    }
    case 'admin-role':
      await updateConfig(c.env, guildId, { admin_role_id: o.role ?? null });
      return reply(o.role ? `✅ 擁有 <@&${o.role}> 的成員可以管理投票` : '✅ 已清除投票管理員身分組（僅「管理伺服器」權限可管理）');
    case 'timezone':
      if (!isValidTimeZone(o.tz)) return reply(`❌ 不認得時區「${o.tz}」，例如 Asia/Taipei、Asia/Tokyo、America/Los_Angeles。`);
      await updateConfig(c.env, guildId, { timezone: o.tz });
      return reply(`✅ 時區設為 ${o.tz}`);
    case 'sheet': {
      if (!o.spreadsheet) {
        await updateConfig(c.env, guildId, { sheet_id: null });
        return reply('✅ 已清除 Google 試算表設定');
      }
      const sheetId = String(o.spreadsheet).match(/\/d\/([\w-]+)/)?.[1] ?? String(o.spreadsheet).trim();
      await updateConfig(c.env, guildId, { sheet_id: sheetId });
      const share = sheetsConfigured(c.env)
        ? `請把試算表以「編輯者」分享給 \`${c.env.GOOGLE_SA_EMAIL}\`。`
        : '⚠️ bot 尚未設定 Google service account，部署者需要設定 GOOGLE_SA_EMAIL / GOOGLE_SA_KEY。';
      return reply(`✅ 匯出試算表已設定。${share}`);
    }
  }
  return reply('未知的子指令');
}

export async function handleTemplate(c: Ctx): Promise<Response> {
  const { name, o } = subcommand(c.i);
  const guildId = c.i.guild_id;
  if (!(await isManager(c.env, c.i))) return reply(NOT_MANAGER);

  switch (name) {
    case 'save': {
      const tplName = String(o.name).trim().slice(0, 40);
      const existing = await getTemplate(c.env, guildId, tplName);
      return modal(`t:${tplName}`, truncate(`選項範本：${tplName}`, 45), [
        {
          custom_id: 'options',
          label: '選項：一行一個，前面可放表情，請假加 [請假]',
          style: 2,
          required: true,
          max_length: 4000,
          value: existing?.options_text ?? DEFAULT_OPTIONS_TEXT,
        },
      ]);
    }
    case 'list': {
      const list = await listTemplates(c.env, guildId);
      if (!list.length) return reply('還沒有任何範本，用 `/vote-template save` 建立一個。');
      return reply('', {
        embeds: [
          {
            title: '📑 選項範本',
            color: 0x5865f2,
            fields: list.slice(0, 25).map((t) => ({ name: t.name, value: truncate(t.options_text, 1024) })),
          },
        ],
      });
    }
    case 'delete':
      return reply((await deleteTemplate(c.env, guildId, o.name)) ? `🗑️ 已刪除範本「${o.name}」` : `找不到範本「${o.name}」`);
  }
  return reply('未知的子指令');
}
