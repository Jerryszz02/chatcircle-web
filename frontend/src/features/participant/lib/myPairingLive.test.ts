import type PocketBase from 'pocketbase';
import type { MyPairingResponse, MyPairingState } from '../../../shared/api/accountEvent';
import { subscribeMyPairing, type MyPairingSubscriptionOptions } from './myPairingLive';

const snapshot = (
  updatedAt: string,
  state: MyPairingState = 'waiting_to_start',
): MyPairingResponse => ({
  contract_version: '2026-08-28.t0-v1',
  activity_id: 'activity-1',
  state,
  onsite_code: 'S01',
  updated_at: updatedAt,
});

function fakeClient(options: { failSubscribe?: boolean } = {}) {
  const log: string[] = [];
  const callbacks = new Map<string, (data?: unknown) => void>();
  const releases: string[] = [];
  const responses = [snapshot('initial'), snapshot('event'), snapshot('reconnected')];
  let requestCount = 0;
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

const subscribeOptions = (
  fake: ReturnType<typeof fakeClient>,
  extra: Partial<MyPairingSubscriptionOptions> = {},
): MyPairingSubscriptionOptions => ({
  client: fake.client,
  activityId: 'activity-1',
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
    const snapshots: MyPairingResponse[] = [];

    const stop = await subscribeMyPairing(
      subscribeOptions(fake, { onSnapshot: (value: MyPairingResponse) => snapshots.push(value) }),
    );

    const fetchIndex = fake.log.findIndex((entry) => entry.startsWith('fetch:'));
    expect(fetchIndex).toBe(3);
    expect(fake.log.slice(0, fetchIndex)).toEqual([
      'subscribe:PB_CONNECT',
      expect.stringContaining('subscribe:checkins:'),
      'subscribe:cc.participant.pairing.pt-1',
    ]);
    expect(fake.log[1]).toContain("participant_id = 'pt-1'");
    expect(fake.log[1]).toContain("activity_id = 'activity-1'");
    expect(fake.log[fetchIndex]).toBe('fetch:/api/cc/activities/activity-1/my-pairing');
    expect(snapshots.map((value) => value.updated_at)).toEqual(['initial']);

    await stop();
    expect(fake.releases).toEqual(['PB_CONNECT', 'checkins', 'cc.participant.pairing.pt-1']);
  });

  it('checkins 与配对 topic 事件防抖合并重拉；其它活动的配对消息被忽略', async () => {
    const fake = fakeClient();
    const snapshots: string[] = [];
    const stop = await subscribeMyPairing(
      subscribeOptions(fake, {
        onSnapshot: (value: MyPairingResponse) => snapshots.push(value.updated_at),
      }),
    );
    expect(fake.requestCount()).toBe(1);

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
    expect(fake.requestCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.requestCount()).toBe(2);
    expect(snapshots).toEqual(['initial', 'event']);

    await stop();
  });

  it('PB_CONNECT 重连后无条件刷新快照并更新连接状态', async () => {
    const fake = fakeClient();
    const snapshots: string[] = [];
    const statuses: string[] = [];
    const stop = await subscribeMyPairing(
      subscribeOptions(fake, {
        onSnapshot: (value: MyPairingResponse) => snapshots.push(value.updated_at),
        onStatusChange: (value: string) => statuses.push(value),
      }),
    );
    expect(statuses.at(-1)).toBe('online');

    fake.realtime.isConnected = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses.at(-1)).toBe('offline');

    fake.realtime.isConnected = true;
    fake.callbacks.get('PB_CONNECT')?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.requestCount()).toBe(2);
    expect(snapshots).toEqual(['initial', 'event']);
    expect(statuses.at(-1)).toBe('online');

    await stop();
  });

  it('Realtime 订阅失败时降级：仍下发一次性快照并标记 offline', async () => {
    const fake = fakeClient({ failSubscribe: true });
    const snapshots: string[] = [];
    const statuses: string[] = [];
    const errors: string[] = [];
    const stop = await subscribeMyPairing(
      subscribeOptions(fake, {
        onSnapshot: (value: MyPairingResponse) => snapshots.push(value.updated_at),
        onStatusChange: (value: string) => statuses.push(value),
        onError: (error: { message: string }) => errors.push(error.message),
      }),
    );

    expect(snapshots).toEqual(['initial']);
    expect(fake.requestCount()).toBe(1);
    expect(statuses.at(-1)).toBe('offline');
    expect(errors.length).toBeGreaterThan(0);
    // 订阅失败后主动 unsubscribe，排空 SDK 内残留的 pendingConnects，避免后续订阅挂起
    expect(fake.log).toContain('unsubscribe');

    await stop();
  });

  it('初始快照失败时抛出错误并可安全停止', async () => {
    const fake = fakeClient();
    fake.client.send = async () => {
      throw new Error('network down');
    };

    await expect(
      subscribeMyPairing(subscribeOptions(fake, { onSnapshot: () => {} })),
    ).rejects.toThrow('network down');
  });
});
