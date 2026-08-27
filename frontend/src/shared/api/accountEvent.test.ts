import {
  ACCOUNT_EVENT_CONTRACT_VERSION,
  ACCOUNT_EVENT_ENDPOINTS,
  ACTIVITY_LIVE_REALTIME_SOURCES,
  PARTICIPANT_PAIRING_REALTIME_SOURCES,
  STANDARD_REGISTRATION_FIELDS,
} from './accountEvent';

describe('account-event T0 共享契约', () => {
  it('冻结标准报名字段的代码、必填性与敏感性', () => {
    expect(STANDARD_REGISTRATION_FIELDS.map((field) => field.field_code)).toEqual([
      'FULL_NAME',
      'GENDER',
      'AGE_RANGE',
    ]);
    expect(new Set(STANDARD_REGISTRATION_FIELDS.map((field) => field.field_code)).size).toBe(
      STANDARD_REGISTRATION_FIELDS.length,
    );

    const fullName = STANDARD_REGISTRATION_FIELDS.find((field) => field.field_code === 'FULL_NAME');
    expect(fullName).toMatchObject({
      required_default: true,
      is_sensitive: true,
      analysis_usage: 'contact_and_pairing_only',
    });

    const ageRange = STANDARD_REGISTRATION_FIELDS.find((field) => field.field_code === 'AGE_RANGE');
    expect(ageRange).toMatchObject({
      field_type: 'single_choice',
      analysis_usage: 'aggregate_only',
    });
  });

  it('生成稳定且安全编码的活动端点', () => {
    expect(ACCOUNT_EVENT_CONTRACT_VERSION).toBe('2026-08-28.t0-v1');
    expect(ACCOUNT_EVENT_ENDPOINTS.activityLiveSummary('act/1')).toBe(
      '/api/cc/activities/act%2F1/live-summary',
    );
    expect(ACCOUNT_EVENT_ENDPOINTS.startPairings('act 1')).toBe(
      '/api/cc/activities/act%201/pairings/start',
    );
    expect(ACCOUNT_EVENT_ENDPOINTS.myPairing('act1')).toBe('/api/cc/activities/act1/my-pairing');
  });

  it('实时事件只作为快照无效化信号', () => {
    expect(ACTIVITY_LIVE_REALTIME_SOURCES).toEqual([
      'registrations',
      'checkins',
      'submissions',
      'activity_pairs',
    ]);
    expect(PARTICIPANT_PAIRING_REALTIME_SOURCES).toEqual(['checkins', 'activity_pairs']);
  });
});
