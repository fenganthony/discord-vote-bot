import type { Ctx } from '../types';
import { getConfig, listTemplates, searchPolls } from '../db';
import { json } from '../respond';
import { formatTs } from '../time';
import { truncate } from '../util';

function focusedOption(options: any[] | undefined): any {
  for (const o of options ?? []) {
    if (o.focused) return o;
    const nested = focusedOption(o.options);
    if (nested) return nested;
  }
  return null;
}

export async function handleAutocomplete(c: Ctx): Promise<Response> {
  const focused = focusedOption(c.i.data.options);
  const q = String(focused?.value ?? '').trim();
  let choices: { name: string; value: string }[] = [];

  if (focused?.name === 'id') {
    const [polls, cfg] = await Promise.all([searchPolls(c.env, c.i.guild_id, q), getConfig(c.env, c.i.guild_id)]);
    choices = polls.map((p) => ({
      name: truncate(`${p.id}・${p.status === 'open' ? '🟢' : '🔒'} ${p.title}・截止 ${formatTs(p.deadline_at, cfg.timezone, false)}`, 100),
      value: p.id,
    }));
  } else if (focused?.name === 'template' || focused?.name === 'name') {
    const list = await listTemplates(c.env, c.i.guild_id);
    choices = list.filter((t) => t.name.includes(q)).slice(0, 25).map((t) => ({ name: t.name, value: t.name }));
  }

  return json({ type: 8, data: { choices } });
}
