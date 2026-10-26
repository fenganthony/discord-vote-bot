import { DurableObject } from 'cloudflare:workers';
import type { Env, RoleJob } from './types';
import { getPoll } from './db';
import { closePoll, notifyRoleJob, refreshMessage, runRoleJob } from './poll-service';

const REFRESH_DELAY = 2_000; // 合併 2 秒內的投票再更新訊息，避免撞到編輯速率限制
const JOB_BATCH = 25; // 每次 alarm 處理的成員數，留足子請求額度
const JOB_GAP = 1_000;

/**
 * 每個投票一個 Durable Object，負責：
 *   - 截止時間到自動關閉（alarm）
 *   - 合併多次投票後的訊息刷新
 *   - 分批加 / 移除身分組
 */
export class PollDO extends DurableObject<Env> {
  async setDeadline(pollId: string, at: number | null) {
    await this.ctx.storage.put('pollId', pollId);
    if (at === null) await this.ctx.storage.delete('deadline');
    else await this.ctx.storage.put('deadline', at);
    await this.schedule();
  }

  async requestRefresh(pollId: string) {
    await this.ctx.storage.put('pollId', pollId);
    if (await this.ctx.storage.get('refreshAt')) return;
    await this.ctx.storage.put('refreshAt', Date.now() + REFRESH_DELAY);
    await this.schedule();
  }

  async enqueueRoleJob(job: RoleJob) {
    const jobs = (await this.ctx.storage.get<RoleJob[]>('jobs')) ?? [];
    jobs.push(job);
    await this.ctx.storage.put('jobs', jobs);
    await this.schedule();
  }

  async clear() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    const s = this.ctx.storage;
    const now = Date.now();
    const pollId = await s.get<string>('pollId');
    const jobs = (await s.get<RoleJob[]>('jobs')) ?? [];

    const deadline = await s.get<number>('deadline');
    if (pollId && deadline !== undefined && deadline <= now) {
      await s.delete('deadline');
      try {
        const poll = await getPoll(this.env, pollId);
        if (poll?.status === 'open' && poll.deadline_at > now + 5_000) {
          await s.put('deadline', poll.deadline_at); // 截止時間被延後但 DO 沒收到通知
        } else if (poll) {
          const r = await closePoll(this.env, pollId);
          if (r.job) jobs.push(r.job);
        }
      } catch (e) {
        console.error('auto close failed', pollId, e);
      }
    }

    const refreshAt = await s.get<number>('refreshAt');
    if (pollId && refreshAt !== undefined && refreshAt <= now) {
      await s.delete('refreshAt');
      await refreshMessage(this.env, pollId).catch((e) => console.error('refresh failed', pollId, e));
    }

    if (jobs.length) {
      const job = jobs[0];
      const done = await runRoleJob(this.env, job, JOB_BATCH).catch((e) => {
        console.error('role job failed', e);
        return true;
      });
      if (done) {
        jobs.shift();
        await notifyRoleJob(this.env, job).catch((e) => console.error('notify failed', e));
      }
    }
    if (jobs.length) await s.put('jobs', jobs);
    else await s.delete('jobs');

    await this.schedule();
  }

  private async schedule() {
    const s = this.ctx.storage;
    const [deadline, refreshAt, jobs] = await Promise.all([s.get<number>('deadline'), s.get<number>('refreshAt'), s.get<RoleJob[]>('jobs')]);
    const times = [deadline, refreshAt, jobs?.length ? Date.now() + JOB_GAP : undefined].filter((t): t is number => typeof t === 'number');
    if (times.length) await s.setAlarm(Math.min(...times));
    else await s.deleteAlarm();
  }
}
