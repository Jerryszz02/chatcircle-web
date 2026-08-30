import type { ActivityLiveSummaryResponse } from '../../../shared/api/accountEvent';
import type { ActivityRecord } from '../../../shared/api/types';
import {
  buildRegistrationTrend,
  buildWeComNotice,
  buildWorkbenchCsv,
  computeStructureExtras,
  deriveActivityStage,
  findMissingItems,
  formatCompletion,
  formatPercent,
  suppressSmallBuckets,
  validateWizardBasics,
  validateWizardRegistration,
  type CompletenessInput,
  type LifecycleActivity,
  type RegistrationLike,
} from './workbench';

/** 构造 published 活动（默认报名开放、窗口覆盖 now、名额 10）。 */
function makeActivity(patch: Partial<LifecycleActivity> = {}): LifecycleActivity {
  return {
    status: 'published',
    start_time: '2026-09-01 09:00:00.000Z',
    end_time: '2026-09-01 12:00:00.000Z',
    registration_open: true,
    registration_start_at: '2026-08-01 00:00:00.000Z',
    registration_end_at: '2026-08-31 23:59:00.000Z',
    capacity_total: 10,
    ...patch,
  };
}

const NOW_BEFORE = new Date('2026-08-20T08:00:00Z');
const NOW_DURING = new Date('2026-09-01T10:00:00Z');
const NOW_AFTER = new Date('2026-09-02T08:00:00Z');

describe('deriveActivityStage 生命周期阶段', () => {
  it('未发布（草稿/待审核/已驳回）为筹备中', () => {
    for (const status of ['draft', 'pending_review', 'rejected'] as const) {
      expect(deriveActivityStage(makeActivity({ status }), NOW_BEFORE, 0)).toBe('setup');
    }
  });

  it('已关闭/已下架/已归档为活动后；已发布但已过结束时间也为活动后', () => {
    for (const status of ['closed', 'taken_down', 'archived'] as const) {
      expect(deriveActivityStage(makeActivity({ status }), NOW_BEFORE, 0)).toBe('post_event');
    }
    expect(deriveActivityStage(makeActivity(), NOW_AFTER, 0)).toBe('post_event');
  });

  it('报名接受中（开关开 + 窗口内 + 名额未满）为招募中', () => {
    expect(deriveActivityStage(makeActivity(), NOW_BEFORE, 3)).toBe('recruiting');
  });

  it('报名满员或窗口关闭且活动未开始为活动前', () => {
    expect(deriveActivityStage(makeActivity(), NOW_BEFORE, 10)).toBe('pre_event');
    expect(deriveActivityStage(makeActivity({ registration_open: false }), NOW_BEFORE, 0)).toBe(
      'pre_event',
    );
    expect(
      deriveActivityStage(
        makeActivity({ registration_end_at: '2026-08-10 00:00:00.000Z' }),
        NOW_BEFORE,
        0,
      ),
    ).toBe('pre_event');
  });

  it('活动时间内或配对已开始/现场已锁定为现场中', () => {
    expect(deriveActivityStage(makeActivity(), NOW_DURING, 5)).toBe('onsite');
    expect(
      deriveActivityStage(makeActivity({ pairing_started_at: '2026-09-01 09:30:00.000Z' }), NOW_BEFORE, 5),
    ).toBe('onsite');
    expect(
      deriveActivityStage(makeActivity({ onsite_locked_at: '2026-09-01 09:30:00.000Z' }), NOW_BEFORE, 5),
    ).toBe('onsite');
  });

  it('结束时间已过即进入活动后，即使配对已开始（Codex review 回归）', () => {
    expect(
      deriveActivityStage(makeActivity({ pairing_started_at: '2026-09-01 09:30:00.000Z' }), NOW_AFTER, 5),
    ).toBe('post_event');
    expect(
      deriveActivityStage(makeActivity({ onsite_locked_at: '2026-09-01 09:30:00.000Z' }), NOW_AFTER, 5),
    ).toBe('post_event');
  });
});

describe('formatPercent / formatCompletion 完成率口径', () => {
  it('分母为 0（rate=null）显示「—」，比例夹在 0–100%', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.856)).toBe('85.6%');
    expect(formatPercent(1.2)).toBe('100%');
    expect(formatPercent(-0.5)).toBe('0%');
  });

  it('完成率组合行包含已提交/符合资格与比率', () => {
    expect(formatCompletion({ eligible: 4, submitted: 3, rate: 0.75 })).toBe('3/4（75%）');
    expect(formatCompletion({ eligible: 0, submitted: 0, rate: null })).toBe('0/0（—）');
  });
});

describe('buildRegistrationTrend 报名趋势', () => {
  it('按本地自然日分组并补零，窗口为最近 N 天', () => {
    const now = new Date('2026-08-20T12:00:00Z');
    const regs = [
      { submitted_at: '2026-08-18T02:00:00.000Z' },
      { submitted_at: '2026-08-18T05:00:00.000Z' },
      { submitted_at: '2026-07-01T00:00:00.000Z' }, // 窗口外
      { submitted_at: '' }, // 非法值忽略
    ];
    const trend = buildRegistrationTrend(regs, 3, now);
    expect(trend.map((p) => p.date)).toEqual(['2026-08-18', '2026-08-19', '2026-08-20']);
    expect(trend.map((p) => p.count)).toEqual([2, 0, 0]);
  });
});

describe('suppressSmallBuckets 小样本联合抑制', () => {
  it('任一分组 <5 时该维度全部分组抑制，计数置 null', () => {
    const buckets = suppressSmallBuckets([
      { key: 'female', label: '女', count: 10 },
      { key: 'male', label: '男', count: 2 },
    ]);
    expect(buckets.every((b) => b.suppressed && b.count === null)).toBe(true);
  });

  it('全部分组 ≥5 时正常展示；0 人分桶不展示', () => {
    const buckets = suppressSmallBuckets([
      { key: 'a', label: 'A', count: 5 },
      { key: 'b', label: 'B', count: 0 },
      { key: 'c', label: 'C', count: 7 },
    ]);
    expect(buckets).toEqual([
      { key: 'a', label: 'A', count: 5, suppressed: false },
      { key: 'c', label: 'C', count: 7, suppressed: false },
    ]);
  });
});

describe('computeStructureExtras 参与者结构', () => {
  const activityRegs: RegistrationLike[] = [
    { participant_id: 'p1', activity_id: 'act', status: 'approved', submitted_at: '2026-08-10 10:00:00.000Z' },
    { participant_id: 'p2', activity_id: 'act', status: 'approved', submitted_at: '2026-08-25 10:00:00.000Z' },
    { participant_id: 'p3', activity_id: 'act', status: 'approved', submitted_at: '2026-08-30 10:00:00.000Z' },
    { participant_id: 'p4', activity_id: 'act', status: 'approved', submitted_at: '2026-09-01 08:00:00.000Z' },
    { participant_id: 'p5', activity_id: 'act', status: 'approved', submitted_at: '2026-08-15 10:00:00.000Z' },
    { participant_id: 'p6', activity_id: 'act', status: 'pending', submitted_at: '2026-08-15 10:00:00.000Z' },
  ];
  const orgApproved: RegistrationLike[] = [
    ...activityRegs.filter((r) => r.status === 'approved'),
    // p2 半年前参加过本机构另一场活动 → 回访 + 历史 2 次
    { participant_id: 'p2', activity_id: 'old', status: 'approved', submitted_at: '2026-03-01 10:00:00.000Z' },
  ];

  it('按本场 approved 聚合新老年/历史次数/报名提前量', () => {
    const extras = computeStructureExtras(activityRegs, orgApproved, '2026-09-01 09:00:00.000Z');
    expect(extras.baseCount).toBe(5);
    // 5 个 approved：4 新 1 回访 → 回访桶 <5，全维度抑制
    expect(extras.newcomer.every((b) => b.suppressed)).toBe(true);
    // 历史次数：4 人 1 次、1 人 2 次 → 抑制
    expect(extras.history.every((b) => b.suppressed)).toBe(true);
    // 提前量：p1 提前 22 天、p5 提前 17 天、p2 提前 7 天、p3 提前 1 天、p4 当天
    const lead = extras.leadTime.map((b) => [b.key, b.count, b.suppressed]);
    expect(lead).toContainEqual(['same_day', null, true]);
    expect(lead).toContainEqual(['d8_plus', null, true]);
  });

  it('所有维度分桶均 ≥5 时不抑制', () => {
    const many: RegistrationLike[] = [];
    for (let i = 0; i < 5; i++) {
      many.push({
        participant_id: `n${i}`,
        activity_id: 'act',
        status: 'approved',
        submitted_at: '2026-08-01 10:00:00.000Z',
      });
    }
    for (let i = 0; i < 5; i++) {
      many.push({
        participant_id: `r${i}`,
        activity_id: 'act',
        status: 'approved',
        submitted_at: '2026-08-20 10:00:00.000Z',
      });
      many.push({
        participant_id: `r${i}`,
        activity_id: 'old',
        status: 'approved',
        submitted_at: '2026-01-01 10:00:00.000Z',
      });
    }
    const extras = computeStructureExtras(
      many.filter((r) => r.activity_id === 'act'),
      many,
      '2026-09-01 09:00:00.000Z',
    );
    expect(extras.newcomer).toEqual([
      { key: 'new', label: '新参与者', count: 5, suppressed: false },
      { key: 'returning', label: '回访参与者', count: 5, suppressed: false },
    ]);
  });
});

describe('validateWizardBasics 创建向导基本信息校验', () => {
  const valid = {
    title: '测试活动',
    activityCode: 'CC_T4_202609_01',
    startTime: '2026-09-01T09:00',
    endTime: '2026-09-01T12:00',
    capacityTotal: '20',
  };

  it('合法输入无错误', () => {
    expect(validateWizardBasics(valid)).toEqual({});
  });

  it('缺标题/代码、时间倒置、名额非正偶数时逐项报错', () => {
    const errors = validateWizardBasics({
      title: ' ',
      activityCode: '',
      startTime: '2026-09-01T12:00',
      endTime: '2026-09-01T09:00',
      capacityTotal: '7',
    });
    expect(errors.title).toBeTruthy();
    expect(errors.activity_code).toBeTruthy();
    expect(errors.end_time).toBeTruthy();
    expect(errors.capacity_total).toBeTruthy();
  });
});

describe('validateWizardRegistration 报名窗口校验', () => {
  it('窗口留空或先后有序时通过', () => {
    expect(validateWizardRegistration({ regStart: '', regEnd: '' })).toEqual({});
    expect(
      validateWizardRegistration({ regStart: '2026-08-01T09:00', regEnd: '2026-08-31T18:00' }),
    ).toEqual({});
  });

  it('结束不晚于开始时报错（与编辑表单口径一致，Codex review 回归）', () => {
    const errors = validateWizardRegistration({
      regStart: '2026-08-31T18:00',
      regEnd: '2026-08-01T09:00',
    });
    expect(errors.registration_end_at).toBeTruthy();
  });
});

describe('findMissingItems 预览缺失项', () => {
  const complete: CompletenessInput = {
    title: '测试活动',
    activityCode: 'CC_T4',
    description: '介绍',
    location: '上海',
    timeRangeValid: true,
    capacityValid: true,
    enabledFieldCount: 2,
    fullNameReady: true,
    surveyCount: 1,
  };

  it('完整配置无缺失项', () => {
    expect(findMissingItems(complete)).toEqual([]);
  });

  it('缺介绍/地点/字段/问卷时给出对应下一步提示', () => {
    const items = findMissingItems({
      ...complete,
      description: '',
      location: ' ',
      enabledFieldCount: 0,
      fullNameReady: false,
      surveyCount: 0,
    });
    const keys = items.map((i) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining(['description', 'location', 'fields', 'full_name', 'surveys']),
    );
  });
});

describe('buildWeComNotice 微信群通知文案', () => {
  it('包含标题、时间、地点与已通过人数', () => {
    const text = buildWeComNotice(
      {
        title: '秋季倾诉会',
        start_time: '2026-09-01 09:00:00.000Z',
        end_time: '2026-09-01 12:00:00.000Z',
        location: '上海',
      },
      12,
    );
    expect(text).toContain('秋季倾诉会');
    expect(text).toContain('上海');
    expect(text).toContain('12 人');
  });

  it('无地点时使用兜底文案', () => {
    const text = buildWeComNotice(
      { title: 't', start_time: '2026-09-01 09:00:00.000Z', end_time: '2026-09-01 12:00:00.000Z', location: '' },
      0,
    );
    expect(text).toContain('见群内后续通知');
  });
});

describe('buildWorkbenchCsv 导出当前视图', () => {
  function makeSnapshot(): ActivityLiveSummaryResponse {
    const rc = (total: number, speaker: number, listener: number) => ({ total, speaker, listener });
    return {
      contract_version: '2026-08-28.t0-v1',
      activity_id: 'act1',
      generated_at: '2026-09-01T10:00:00.000Z',
      onsite: {},
      registrations: {
        total: rc(8, 5, 3),
        pending: rc(2, 1, 1),
        approved: rc(6, 4, 2),
        rejected: rc(0, 0, 0),
        cancelled: rc(0, 0, 0),
      },
      checkins: {
        approved: rc(6, 4, 2),
        valid: rc(5, 3, 2),
        rate: { total: 5 / 6, speaker: 0.75, listener: 1 },
      },
      pairings: { active_pairs: 2, waiting: rc(1, 1, 0), imbalance: 1 },
      surveys: [
        {
          activity_survey_id: 'sv1',
          title: '活动后问卷',
          onsite_completion: { eligible: 5, submitted: 4, rate: 0.8 },
          overall_completion: { eligible: 6, submitted: 4, rate: 4 / 6 },
        },
      ],
      demographics: {
        suppression_threshold: 5,
        gender: [{ key: 'female', count: null, suppressed: true }],
        age_range: [{ key: '25_34', count: 6, suppressed: false }],
      },
      recent_checkins: [],
    };
  }

  it('输出带 BOM 的 CSV，含漏斗/签到/配对/问卷与抑制口径', () => {
    const csv = buildWorkbenchCsv(makeSnapshot(), {
      title: '秋季倾诉会',
      activity_code: 'CC_T4',
    } as ActivityRecord);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('报名总数,8,5,3');
    expect(csv).toContain('签到率,83.3%,75%,100%');
    expect(csv).toContain('已配对组数,2');
    expect(csv).toContain('活动后问卷,4/5,80%,4/6,66.7%,1');
    expect(csv).toContain('性别,female,样本不足');
    expect(csv).toContain('年龄段,25_34,6');
  });

  it('包含逗号/引号的文本被正确转义', () => {
    const csv = buildWorkbenchCsv(makeSnapshot(), {
      title: '含,逗号"引号',
      activity_code: 'CC_T4',
    } as ActivityRecord);
    expect(csv).toContain('"含,逗号""引号"');
  });
});
