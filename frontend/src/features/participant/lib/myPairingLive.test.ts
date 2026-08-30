import type PocketBase from 'pocketbase';
import type { MyPairingResponse, MyPairingState } from '../../../shared/api/accountEvent';
import { subscribeMyPairing, type MyPairingSubscriptionOptions } from './myPairingLive';

const snapshot = (
  updatedAt: string,
  activityId = 'activity-1',
  state: MyPairingState = 'waiting_to_start',
): MyPairingResponse => ({
  contract_version: '2026-08-28.t0-v1',
  activity_id: activityId,
  state,
  onsite_code: 'S01',
  updated_at: updatedAt,
});

function fakeClient(options: { failSubscribe?: boolean; failFetchFor?: string } = {}) {
  const log: string[] = [];
  const callbacks = new Map<string, (data?: unknown) => void>();
  const releases: string[] = [];
  const counters = new Map<string, number>();
  const realtime = {
    isConnected: false,
    async unsubscribe() {
      log.push('unsubscribe');
    },
    async subscribe(topic: string, callback: (data?: unknown) => void) {
      if (options.failSubscribe) throw new Error('EventSource unavailable');
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
      let out = expression;
      for (const [key, value] of Object.entries(params)) {
        out = out.replace(`{:${key}}`, `'${value}'`);
      }
      return out;
    },
    collection(name: string) {
      return {
        async subscribe(_topic: string, callback: () => void, subscribeOptions: unknown) {
          log.push(`subscribe:${name}:${JSON.stringify(subscribeOptions)}`);
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
      const activityId = /activities\/([^/]+)\/my-pairing/.exec(path)?.[1] ?? 'activity-1';
      if (options.failFetchFor === activityId) throw new Error('network down');
      const round = counters.get(activityId) ?? 0;
      counters.set(activityId, round + 1);
      return snapshot(`fetch-${round}`, activityId);
    },
  };
  return {
    client: client as unknown as PocketBase,
    callbacks,
    log,
    releases,
    realtime,
    fetchCount: (activityId: string) => counters.get(activityId) ?? 0,
  };
}

const subscribeOptions = (
  fake: ReturnType<typeof fakeClient>,
  extra: Partial<MyPairingSubscriptionOptions> = {},
): MyPairingSubscriptionOptions => ({
  client: fake.client,
  activityIds: ['activity-1'],
  participantId: 'pt-1',
  debounceMs: 200,
  connectionPollMs: 100,
  onSnapshot: () => {},
  ...extra,
});

describe('my-pairing realtime invalidation（T5 参与者侧）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('先完成本人订阅再拉初始快照：PB_CONNECT → 本人 checkins → 本人配对 topic', async () => {
    const fake = fakeClient();
    const snapshots: Array<[string, string]> = [];

    const stop = await subscribeMyPairing(
      subscribeOptions(fake, {
        onSnapshot: (activityId, value) => snapshots.push([activityId, value.updated_at]),
      }),
    );

    const fetchIndex = fake.log.findIndex((entry) => entry.startsWith('fetch:'));
    expect(fetchIndex).toBe(3);
    expect(fake.log.slice(0, fetchIndex)).toEqual([
      'subscribe:PB_CONNECT',
      expect.stringContaining('subscribe:checkins:'),
      'subscribe:cc.participant.pairing.pt-1',
    ]);
    expect(fake.log[1]).toContain("participant_id = 'pt-1'");
    expect(fake.log[fetchIndex]).toBe('fetch:/api/cc/activities/activity-1/my-pairing');
    expect(snapshots).toEqual([['activity-1', 'fetch-0']]);

    await stop();
    expect(fake.releases).toEqual(['PB_CONNECT', 'checkins', 'cc.participant.pairing.pt-1']);
  });

  it('checkins 与配对 topic 事件防抖合并重拉；其它活动的配对消息被忽略', async () => {
    const fake = fakeClient();
    const stop = await subscribeMyPairing(subscribeOptions(fake));
    expect(fake.fetchCount('activity-1')).toBe(1);

    fake.callbacks.get('checkins')?.();
    fake.callbacks.get('cc.participant.pairing.pt-1')?.({
      contract_version: '2026-08-28.t0-v1',
      activity_id: 'activity-1',
      changed_at: '2026-08-29T08:00:00Z',
    });
    // 与本活动无关的配对消息（同一参与者的其它活动）不触发重拉
    fake.callbacks.get('cc.participant.pairing.pt-1')?.({
      contract_version: '2026-08-28.t0-v1',
      activity_id: 'activity-2',
      changed_at: '2026-08-29T08:00:01Z',
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(fake.fetchCount('activity-1')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.fetchCount('activity-1')).toBe(2);

    await stop();
  });

  it('PB_CONNECT 重连后无条件刷新快照并更新连接状态', async () => {
    const fake = fakeClient();
    const statuses: string[] = [];
    const stop = await subscribeMyPairing(
      subscribeOptions(fake, { onStatusChange: (value) => statuses.push(value) }),
    );
    expect(statuses.at(-1)).toBe('online');

    fake.realtime.isConnected = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses.at(-1)).toBe('offline');

    fake.realtime.isConnected = true;
    fake.callbacks.get('PB_CONNECT')?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.fetchCount('activity-1')).toBe(2);
    expect(statuses.at(-1)).toBe('online');

    await stop();
  });

  it('Realtime 订阅失败时降级：仍下发一次性快照并标记 offline，不上报拉取错误', async () => {
    const fake = fakeClient({ failSubscribe: true });
    const snapshots: string[] = [];
    const statuses: string[] = [];
    const errors: string[] = [];
    const stop = await subscribeMyPairing(
      subscribeOptions(fake, {
        onSnapshot: (_activityId, value) => snapshots.push(value.updated_at),
        onStatusChange: (value) => statuses.push(value),
        onError: (activityId) => errors.push(activityId),
      }),
    );

    expect(snapshots).toEqual(['fetch-0']);
    expect(statuses.at(-1)).toBe('offline');
    // 订阅失败不是单个活动的拉取错误；快照已正常下发
    expect(errors).toEqual([]);
    // 订阅失败后主动 unsubscribe，排空 SDK 内残留的 pendingConnects，避免后续订阅挂起
    expect(fake.log).toContain('unsubscribe');

    await stop();
  });

  it('快照拉取失败按活动经 onError 上报，不影响其它活动快照', async () => {
    const fake = fakeClient({ failFetchFor: 'activity-2' });
    const snapshots: string[] = [];
    const errors: Array<[string, string]> = [];
    const stop = await subscribeMyPairing(
      subscribeOptions(fake, {
        activityIds: ['activity-1', 'activity-2'],
        onSnapshot: (activityId) => snapshots.push(activityId),
        onError: (activityId, error) => errors.push([activityId, error.message]),
      }),
    );

    expect(snapshots).toEqual(['activity-1']);
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('activity-2');
    expect(errors[0][1]).toBe('network down');

    await stop();
  });

  it('多活动共用一路订阅：任一失效事件重拉全部跟踪活动', async () => {
    const fake = fakeClient();
    const stop = await subscribeMyPairing(
      subscribeOptions(fake, { activityIds: ['activity-1', 'activity-2'] }),
    );
    expect(fake.fetchCount('activity-1')).toBe(1);
    expect(fake.fetchCount('activity-2')).toBe(1);

    // 针对 activity-2 的配对失效消息触发一轮全量重拉（两个活动各一次）
    fake.callbacks.get('cc.participant.pairing.pt-1')?.({
      contract_version: '2026-08-28.t0-v1',
      activity_id: 'activity-2',
      changed_at: '2026-08-29T08:00:00Z',
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.fetchCount('activity-1')).toBe(2);
    expect(fake.fetchCount('activity-2')).toBe(2);

    await stop();
    // 全部订阅只建一套：PB_CONNECT + checkins + 配对 topic
    expect(fake.releases).toEqual(['PB_CONNECT', 'checkins', 'cc.participant.pairing.pt-1']);
  });
});
