import type { Ctx, Env } from './types';
import { cleanupPending, overduePolls } from './db';
import { explainError } from './discord';
import { handleAutocomplete } from './handlers/autocomplete';
import { handleComponent } from './handlers/components';
import { handleConfig, handleTemplate } from './handlers/config';
import { handleModal } from './handlers/modals';
import { handleVote } from './handlers/vote';
import { closePoll, pollStub } from './poll-service';
import { json, reply } from './respond';
import { verifyRequest } from './verify';

export { PollDO } from './poll-do';

async function route(c: Ctx): Promise<Response> {
  const { i } = c;
  if (i.type === 1) return json({ type: 1 }); // PING
  if (!i.guild_id) return reply('請在伺服器頻道中使用這個 bot。');

  switch (i.type) {
    case 2: // 斜線指令
      if (i.data.name === 'vote') return handleVote(c);
      if (i.data.name === 'vote-config') return handleConfig(c);
      if (i.data.name === 'vote-template') return handleTemplate(c);
      break;
    case 3:
      return handleComponent(c);
    case 4:
      return handleAutocomplete(c);
    case 5:
      return handleModal(c);
  }
  return reply('未知的指令');
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    if (req.method === 'GET') return new Response('discord-vote-bot is running');
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const body = await verifyRequest(req, env.DISCORD_PUBLIC_KEY);
    if (body === null) return new Response('Bad request signature', { status: 401 });

    const c: Ctx = { env, ctx, i: JSON.parse(body) };
    try {
      return await route(c);
    } catch (e) {
      console.error(e);
      return reply(`⚠️ 發生錯誤：${explainError(e)}`);
    }
  },

  // 保險：補關閉 DO alarm 沒處理到的逾期投票，並清理過期暫存
  async scheduled(_event, env, _ctx) {
    for (const id of await overduePolls(env, Date.now() - 60_000)) {
      try {
        const r = await closePoll(env, id);
        const stub = pollStub(env, id);
        await stub.setDeadline(id, null);
        if (r.job) await stub.enqueueRoleJob(r.job);
      } catch (e) {
        console.error('cron close failed', id, e);
      }
    }
    await cleanupPending(env);
  },
} satisfies ExportedHandler<Env>;
