import type PocketBase from 'pocketbase';
import type { ActivityLiveSummaryResponse } from '../../../shared/api/accountEvent';
import { subscribeActivityLiveSummary } from './activityLive';

const snapshot = (generatedAt: string): ActivityLiveSummaryResponse => ({
  contract_version: '2026-08-28.t0-v1',
  activity_id: 'activity-1',
  generated_at: generatedAt,
  onsite: {},
  registrations: {
    total: { total: 0, speaker: 0, listener: 0 },
    pending: { total: 0, speaker: 0, listener: 0 },
    approved: { total: 0, speaker: 0, listener: 0 },
    rejected: { total: 0, speaker: 0, listener: 0 },
    cancelled: { total: 0, speaker: 0, listener: 0 },
  },
  checkins: {
    approved: { total: 0, speaker: 0, listener: 0 },
    valid: { total: 0, speaker: 0, listener: 0 },
    rate: { total: null, speaker: null, listener: null },
  },
  pairings: {
    active_pairs: 0,
    waiting: { total: 0, speaker: 0, listener: 0 },
    imbalance: 0,
  },
  surveys: [],
  demographics: { suppression_threshold: 5, gender: [], age_range: [] },
  recent_checkins: [],
});

function fakeClient() {
  const log: string[] = [];
  const callbacks = new Map<string, () => void>();
  const releases: string[] = [];
  const responses = [snapshot('initial'), snapshot('event'), snapshot('reconnected')];
  let requestCount = 0;
  const realtime = {
    isConnected: false,
    async subscribe(topic: string, callback: () => void) {
      log.push(`subscribe:${topic}`);
      callbacks.set(topic, callback);
      if (topic === 'PB_CONNECT') {
        realtime.isConnected = true;
        callback();
      }
      return async () => {
        releases.push(topic);
        callbacks.delete(topic);
      };
    },
  };
  const client = {
    realtime,
    filter(expression: string, params: Record<string, string>) {
      return expression.replace('{:activityId}', `'${params.activityId}'`);
    },
    collection(name: string) {
      return {
        async subscribe(_topic: string, callback: () => void, options: unknown) {
          log.push(`subscribe:${name}:${JSON.stringify(options)}`);
          callbacks.set(name, callback);
          return async () => {
            releases.push(name);
            callbacks.delete(name);
          };
        },
      };
    },
    async send(path: string) {
      log.push(`fetch:${path}`);
      const response = responses[Math.min(requestCount, responses.length - 1)];
      requestCount += 1;
      return response;
    },
  };
  return {
    client: client as unknown as PocketBase,
    callbacks,
    log,
    releases,
    realtime,
    requestCount: () => requestCount,
  };
}

describe('activity live realtime invalidation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('先完成全部六类依赖订阅再拉初始快照，并使用活动范围过滤', async () => {
    const fake = fakeClient();
    const snapshots: ActivityLiveSummaryResponse[] = [];

    const stop = await subscribeActivityLiveSummary({
      client: fake.client,
      activityId: 'activity-1',
      onSnapshot: (value) => snapshots.push(value),
    });

    const fetchIndex = fake.log.findIndex((entry) => entry.startsWith('fetch:'));
    expect(fetchIndex).toBe(7);
    expect(fake.log.slice(0, fetchIndex).map((entry) => entry.split(':')[1])).toEqual([
      'PB_CONNECT',
      'activities',
      'registrations',
      'checkins',
      'activity_surveys',
      'submissions',
      'activity_pairs',
    ]);
    expect(fake.log.find((entry) => entry.startsWith('subscribe:activities'))).toContain(
      "id = 'activity-1'",
    );
    expect(fake.log.find((entry) => entry.startsWith('subscribe:activity_surveys'))).toContain(
      "activity_id = 'activity-1'",
    );
    expect(fake.log.find((entry) => entry.startsWith('subscribe:submissions'))).toContain(
      "activity_survey_id.activity_id = 'activity-1'",
    );
    expect(snapshots.map((value) => value.generated_at)).toEqual(['initial']);

    await stop();
  });

  it('合并连续失效事件，并在 PB_CONNECT 重连后无条件刷新快照', async () => {
    const fake = fakeClient();
    const snapshots: string[] = [];
    const statuses: string[] = [];
    const stop = await subscribeActivityLiveSummary({
      client: fake.client,
      activityId: 'activity-1',
      debounceMs: 200,
      connectionPollMs: 100,
      onSnapshot: (value) => snapshots.push(value.generated_at),
      onStatusChange: (value) => statuses.push(value),
    });

    fake.callbacks.get('activities')?.();
    fake.callbacks.get('activity_surveys')?.();
    await vi.advanceTimersByTimeAsync(199);
    expect(fake.requestCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.requestCount()).toBe(2);
    expect(snapshots).toEqual(['initial', 'event']);

    fake.realtime.isConnected = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses.at(-1)).toBe('offline');
    fake.realtime.isConnected = true;
    fake.callbacks.get('PB_CONNECT')?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.requestCount()).toBe(3);
    expect(snapshots).toEqual(['initial', 'event', 'reconnected']);
    expect(statuses.at(-1)).toBe('online');

    await stop();
    expect(fake.releases).toEqual([
      'PB_CONNECT',
      'activities',
      'registrations',
      'checkins',
      'activity_surveys',
      'submissions',
      'activity_pairs',
    ]);
  });
});
