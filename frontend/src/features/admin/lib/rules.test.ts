import { describe, expect, it } from 'vitest';
import type { ActivityStatus, RegistrationStatus, SurveyStatus } from '../../../shared/api/types';
import {
  availableActivityActions,
  availableSurveyActions,
  canTransitionRegistration,
  countApproved,
  isRoleFull,
  mergeFormConfig,
  parseFormConfig,
  remainingCapacity,
  setFormFieldConfig,
  transitionRequiresReason,
  validateCapacityEdit,
  validateTransitionForm,
  type ApprovedCounts,
  type CapacityInput,
  type RemainingCapacity,
} from './rules';

/**
 * 机构管理端业务规则单测（test-plan §2 L1：状态迁移矩阵判定、名额校验决策）。
 * 这些纯函数是服务端规则的「体验层镜像」，口径依据：
 * PRD §4.3 活动状态机、§4.4 报名迁移矩阵、§4.5 问卷状态机、FR-ACT-006 名额下限、FR-REG-008 原因必填。
 */

const ALL_ACTIVITY_STATUS: ActivityStatus[] = [
  'draft',
  'pending_review',
  'rejected',
  'published',
  'closed',
  'taken_down',
  'archived',
];

const ALL_REGISTRATION_STATUS: RegistrationStatus[] = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
];

const ALL_SURVEY_STATUS: SurveyStatus[] = ['draft', 'not_open', 'open', 'ended', 'archived'];

describe('活动状态机按钮可用性（availableActivityActions）', () => {
  it('机构开启发布审核：草稿与已驳回仅可提交审核', () => {
    expect(availableActivityActions('draft', true)).toEqual(['submit-review']);
    expect(availableActivityActions('rejected', true)).toEqual(['submit-review']);
  });

  it('机构未开启发布审核：草稿与已驳回可直接发布', () => {
    expect(availableActivityActions('draft', false)).toEqual(['publish']);
    expect(availableActivityActions('rejected', false)).toEqual(['publish']);
  });

  it('已发布可关闭、已关闭可归档，均与审核开关无关', () => {
    expect(availableActivityActions('published', true)).toEqual(['close']);
    expect(availableActivityActions('published', false)).toEqual(['close']);
    expect(availableActivityActions('closed', true)).toEqual(['archive']);
    expect(availableActivityActions('closed', false)).toEqual(['archive']);
  });

  it('待审核/已下架/已归档：管理员无可用动作（批准/驳回/下架为超管动作）', () => {
    for (const status of ALL_ACTIVITY_STATUS) {
      const actions = availableActivityActions(status, true);
      if (status === 'pending_review' || status === 'taken_down' || status === 'archived') {
        expect(actions).toEqual([]);
      }
    }
  });
});

describe('报名迁移矩阵（canTransitionRegistration）', () => {
  const LEGAL: Array<[RegistrationStatus, RegistrationStatus]> = [
    ['pending', 'approved'],
    ['pending', 'rejected'],
    ['approved', 'cancelled'],
    ['rejected', 'approved'],
    ['cancelled', 'approved'],
  ];

  it('矩阵内 5 种迁移全部允许（PRD §4.4）', () => {
    for (const [from, to] of LEGAL) {
      expect(canTransitionRegistration(from, to)).toBe(true);
    }
  });

  it('矩阵外全部组合（含同状态）一律拒绝', () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL_REGISTRATION_STATUS) {
      for (const to of ALL_REGISTRATION_STATUS) {
        if (!legalSet.has(`${from}->${to}`)) {
          expect(canTransitionRegistration(from, to)).toBe(false);
        }
      }
    }
  });

  it('原因必填：取消与回退强制填写原因（FR-REG-008）', () => {
    expect(transitionRequiresReason('approved', 'cancelled')).toBe(true);
    expect(transitionRequiresReason('rejected', 'approved')).toBe(true);
    expect(transitionRequiresReason('cancelled', 'approved')).toBe(true);
    expect(transitionRequiresReason('pending', 'approved')).toBe(false);
    expect(transitionRequiresReason('pending', 'rejected')).toBe(false);
  });
});

describe('审核表单逻辑（validateTransitionForm）', () => {
  const remaining: RemainingCapacity = { total: 3, speaker: 2, listener: 1 };

  it('矩阵外迁移：返回 to 错误且不继续校验', () => {
    const errors = validateTransitionForm(
      'pending',
      'speaker',
      { to: 'cancelled' },
      remaining,
    );
    expect(errors.to).toBeTruthy();
    expect(errors.reason).toBeUndefined();
  });

  it('取消缺原因：返回 reason 错误；填原因后通过', () => {
    const missing = validateTransitionForm(
      'approved',
      'speaker',
      { to: 'cancelled' },
      remaining,
    );
    expect(missing.reason).toContain('原因');
    const ok = validateTransitionForm(
      'approved',
      'speaker',
      { to: 'cancelled', reason: '线下申请退出' },
      remaining,
    );
    expect(ok).toEqual({});
  });

  it('回退（rejected→approved）缺原因：拒绝并提示原因必填', () => {
    const errors = validateTransitionForm('rejected', 'speaker', { to: 'approved' }, remaining);
    expect(errors.reason).toBeTruthy();
  });

  it('拒绝报名（pending→rejected）：原因选填，不填也可提交', () => {
    expect(validateTransitionForm('pending', 'speaker', { to: 'rejected' }, remaining)).toEqual({});
  });

  it('审核通过：目标角色满额时给出角色错误（名额硬校验的体验层镜像）', () => {
    const full: RemainingCapacity = { total: 3, speaker: 0, listener: 5 };
    // 当前 speaker，改为满额的 speaker → 拒绝
    const errors = validateTransitionForm(
      'pending',
      'listener',
      { to: 'approved', activity_role: 'speaker' },
      full,
    );
    expect(errors.activity_role).toContain('名额已满');
    // 改为有剩余的角色 → 通过
    const ok = validateTransitionForm(
      'pending',
      'listener',
      { to: 'approved', activity_role: 'listener' },
      full,
    );
    expect(ok).toEqual({});
  });

  it('审核通过：总名额满时任何角色都不可通过', () => {
    const full: RemainingCapacity = { total: 0, speaker: 5, listener: 5 };
    const errors = validateTransitionForm('pending', 'speaker', { to: 'approved' }, full);
    expect(errors.activity_role).toBeTruthy();
  });
});

describe('名额校验（FR-ACT-006/007）', () => {
  it('countApproved 按角色统计已通过人数', () => {
    expect(countApproved(['speaker', 'speaker', 'listener'])).toEqual({
      total: 3,
      speaker: 2,
      listener: 1,
    });
    expect(countApproved([])).toEqual({ total: 0, speaker: 0, listener: 0 });
  });

  it('remainingCapacity 剩余名额 = 名额 - 已通过，且不为负', () => {
    const capacity: CapacityInput = {
      capacity_total: 10,
      capacity_speaker: 4,
      capacity_listener: 6,
    };
    expect(remainingCapacity(capacity, { total: 3, speaker: 2, listener: 1 })).toEqual({
      total: 7,
      speaker: 2,
      listener: 5,
    });
    // 超额数据（异常终态）下剩余下限为 0
    expect(remainingCapacity(capacity, { total: 12, speaker: 9, listener: 3 })).toEqual({
      total: 0,
      speaker: 0,
      listener: 3,
    });
  });

  it('isRoleFull：总名额或目标角色名额任一满即视为满', () => {
    expect(isRoleFull({ total: 0, speaker: 3, listener: 3 }, 'speaker')).toBe(true);
    expect(isRoleFull({ total: 2, speaker: 0, listener: 3 }, 'speaker')).toBe(true);
    expect(isRoleFull({ total: 2, speaker: 0, listener: 3 }, 'listener')).toBe(false);
  });

  it('总名额须为正偶数（角色名额自动对半分配）', () => {
    const zero: ApprovedCounts = { total: 0, speaker: 0, listener: 0 };
    for (const bad of [0, -2, 3, 1.5, Number('')]) {
      expect(validateCapacityEdit(bad, zero).capacity_total).toContain('偶数');
    }
    expect(validateCapacityEdit(2, zero)).toEqual({});
    expect(validateCapacityEdit(10, zero)).toEqual({});
  });

  it('名额下限校验：总名额不得低于已通过总数，对半后不得低于单一角色已通过数', () => {
    const counts: ApprovedCounts = { total: 6, speaker: 4, listener: 2 };
    // 总下限：4 < 已通过 6
    expect(validateCapacityEdit(4, counts).capacity_total).toContain('6');
    // 对半下限：6 ≥ 6 但对半 3 < 倾诉者已通过 4
    expect(validateCapacityEdit(6, counts).capacity_total).toContain('4');
    // 对半 4 恰好等于单一角色已通过数，合法
    expect(validateCapacityEdit(8, counts)).toEqual({});
  });
});

describe('问卷状态机动作（availableSurveyActions）', () => {
  it('草稿/未开放可开放；开放中可结束；已结束/已归档无动作', () => {
    expect(availableSurveyActions('draft')).toEqual(['open']);
    expect(availableSurveyActions('not_open')).toEqual(['open']);
    expect(availableSurveyActions('open')).toEqual(['close']);
    expect(availableSurveyActions('ended')).toEqual([]);
    expect(availableSurveyActions('archived')).toEqual([]);
    // 全量状态覆盖，保证新增枚举时显式处理
    for (const status of ALL_SURVEY_STATUS) {
      expect(Array.isArray(availableSurveyActions(status))).toBe(true);
    }
  });
});

describe('报名表配置（form_config_json）', () => {
  it('parseFormConfig：非法输入回退空配置；停用字段的必填被清除', () => {
    expect(parseFormConfig(undefined)).toEqual({ fields: [] });
    expect(parseFormConfig({ nope: 1 })).toEqual({ fields: [] });
    expect(
      parseFormConfig({
        fields: [
          { field_def_id: 'a', enabled: false, required: true },
          { field_def_id: 'b', enabled: true, required: true },
          { enabled: true },
        ],
      }),
    ).toEqual({
      fields: [
        { field_def_id: 'a', enabled: false, required: false },
        { field_def_id: 'b', enabled: true, required: true },
      ],
    });
  });

  it('mergeFormConfig：保留既有配置、新字段取默认必填、丢弃已删除字段', () => {
    const defs = [
      { id: 'std1', required_default: true },
      { id: 'cus1', required_default: false },
    ];
    const merged = mergeFormConfig(defs, {
      fields: [
        { field_def_id: 'std1', enabled: true, required: false },
        { field_def_id: 'gone', enabled: true, required: true },
      ],
    });
    expect(merged).toEqual([
      { field_def_id: 'std1', enabled: true, required: false },
      { field_def_id: 'cus1', enabled: true, required: false },
    ]);
  });

  it('setFormFieldConfig：停用时必填强制为 false；重新启用后按需设置', () => {
    const initial = [{ field_def_id: 'a', enabled: true, required: true }];
    const disabled = setFormFieldConfig(initial, 'a', { enabled: false });
    expect(disabled).toEqual([{ field_def_id: 'a', enabled: false, required: false }]);
    const reenabled = setFormFieldConfig(disabled, 'a', { enabled: true, required: true });
    expect(reenabled).toEqual([{ field_def_id: 'a', enabled: true, required: true }]);
  });
});
