import type {
  ActivityRecord,
  ActivityRole,
  ActivityStatus,
  RegistrationStatus,
  SurveyStatus,
} from '../../../shared/api/types';

/**
 * 机构管理端业务规则纯函数（状态机可用性、名额校验、审核表单校验）。
 *
 * 这些函数只是服务端的「体验层镜像」：真正的强制点在 pb_hooks / collection API rules
 * （technical-design §5.5「前端重复实现仅用于体验，不得成为唯一防线」）。
 * 状态机与迁移矩阵口径必须与后端白名单保持一致（test-plan §2「前后端共用同一份矩阵定义」），
 * 依据：PRD §4.3 活动状态机、§4.4 报名迁移矩阵、§4.5 问卷状态机、FR-ACT-006 名额下限。
 */

// ---------- 活动状态机：管理员可用动作（PRD §4.3、FR-ACT-004） ----------

/** 管理员侧活动动作；端点为 POST /api/cc/activities/:id/<action>。 */
export type AdminActivityAction = 'submit-review' | 'publish' | 'close' | 'archive';

export const ADMIN_ACTIVITY_ACTION_LABELS: Record<AdminActivityAction, string> = {
  'submit-review': '提交平台审核',
  publish: '直接发布',
  close: '关闭活动',
  archive: '归档活动',
};

/**
 * 按当前状态与机构「发布需平台审核」开关计算可用动作。
 * - 草稿/已驳回：开关开 → 提交审核（draft→pending_review、rejected→pending_review 修改重提）；
 *   开关关 → 直接发布（draft→published）。
 * - 已发布 → 关闭；已关闭 → 归档。
 * - 待审核/已下架/已归档：管理员无可执行动作（批准/驳回/下架为超管动作，不在本端）。
 */
export function availableActivityActions(
  status: ActivityStatus,
  requireApproval: boolean,
): AdminActivityAction[] {
  switch (status) {
    case 'draft':
    case 'rejected':
      return requireApproval ? ['submit-review'] : ['publish'];
    case 'published':
      return ['close'];
    case 'closed':
      return ['archive'];
    // 待审核/已下架/已归档：管理员无可执行动作（批准/驳回/下架为超管动作，不在本端）
    default:
      return [];
  }
}

// ---------- 报名状态迁移矩阵（PRD §4.4，矩阵外一律禁止） ----------

/** 迁移白名单：与后端 transition 端点硬编码矩阵保持一致。 */
export const REGISTRATION_TRANSITION_MATRIX: Readonly<
  Record<RegistrationStatus, readonly RegistrationStatus[]>
> = {
  pending: ['approved', 'rejected'],
  approved: ['cancelled'],
  rejected: ['approved'],
  cancelled: ['approved'],
};

/** 矩阵内迁移返回 true；矩阵外（含同状态）一律 false。 */
export function canTransitionRegistration(from: RegistrationStatus, to: RegistrationStatus): boolean {
  return REGISTRATION_TRANSITION_MATRIX[from].includes(to);
}

/**
 * 该迁移是否强制填写原因（FR-REG-008）：
 * 取消（approved→cancelled）与回退（rejected→approved、cancelled→approved）原因必填。
 */
export function transitionRequiresReason(from: RegistrationStatus, to: RegistrationStatus): boolean {
  if (to === 'cancelled') return true;
  return to === 'approved' && (from === 'rejected' || from === 'cancelled');
}

/** 审核表单输入。 */
export interface TransitionFormInput {
  to: RegistrationStatus;
  reason?: string;
  /** 审核时改角色（FR-REG-005：审核通过可同时调整 activity_role）。 */
  activity_role?: ActivityRole;
}

export interface TransitionFormErrors {
  to?: string;
  reason?: string;
  activity_role?: string;
}

/**
 * 审核/取消/回退表单校验：
 * - 迁移必须在矩阵内；
 * - 取消与回退必须填原因；
 * - 目标为 approved 时若当前角色名额已满则不允许（提示先调整名额，FR-REG-005/AC-08 的体验层镜像）。
 */
export function validateTransitionForm(
  from: RegistrationStatus,
  currentRole: ActivityRole,
  input: TransitionFormInput,
  remaining: RemainingCapacity,
): TransitionFormErrors {
  const errors: TransitionFormErrors = {};
  if (!canTransitionRegistration(from, input.to)) {
    errors.to = '不允许的状态变更';
    return errors;
  }
  if (transitionRequiresReason(from, input.to) && !input.reason?.trim()) {
    errors.reason = '取消与回退必须填写原因（FR-REG-008）';
  }
  if (input.to === 'approved') {
    const targetRole = input.activity_role ?? currentRole;
    if (isRoleFull(remaining, targetRole)) {
      errors.activity_role = '目标角色名额已满，无法通过（FR-ACT-006）';
    }
  }
  return errors;
}

// ---------- 名额（FR-ACT-006/007） ----------

/** 当前已通过人数（按角色拆分）。 */
export interface ApprovedCounts {
  total: number;
  speaker: number;
  listener: number;
}

/** 名额三字段（与 activities.capacity_* 对应）。 */
export interface CapacityInput {
  capacity_total: number;
  capacity_speaker: number;
  capacity_listener: number;
}

/** 剩余名额 = 名额 - 当前已通过数（不为负，下限 0）。 */
export interface RemainingCapacity {
  total: number;
  speaker: number;
  listener: number;
}

/** 从已通过报名列表统计各角色人数。 */
export function countApproved(roles: ActivityRole[]): ApprovedCounts {
  const speaker = roles.filter((r) => r === 'speaker').length;
  const listener = roles.length - speaker;
  return { total: roles.length, speaker, listener };
}

export function remainingCapacity(capacity: CapacityInput, counts: ApprovedCounts): RemainingCapacity {
  return {
    total: Math.max(0, capacity.capacity_total - counts.total),
    speaker: Math.max(0, capacity.capacity_speaker - counts.speaker),
    listener: Math.max(0, capacity.capacity_listener - counts.listener),
  };
}

/** 指定角色是否已满（总名额或角色名额任一满即满）。 */
export function isRoleFull(remaining: RemainingCapacity, role: ActivityRole): boolean {
  if (remaining.total <= 0) return true;
  return role === 'speaker' ? remaining.speaker <= 0 : remaining.listener <= 0;
}

export interface CapacityEditErrors {
  capacity_total?: string;
}

/**
 * 名额编辑校验（FR-ACT-006 体验层镜像 + 对半派生不变量）：
 * - 总名额须为正偶数；倾诉者/聆听者名额由总名额对半派生，不在表单单独填写；
 * - 总名额不得低于当前已通过总人数，对半后不得低于单一角色已通过人数
 *   （服务端在 hooks 内硬校验，此处仅做提示）。
 */
export function validateCapacityEdit(
  capacityTotal: number,
  counts: ApprovedCounts,
): CapacityEditErrors {
  const errors: CapacityEditErrors = {};
  if (!Number.isInteger(capacityTotal) || capacityTotal <= 0 || capacityTotal % 2 !== 0) {
    errors.capacity_total = '总名额须为正偶数（倾诉者/聆听者名额自动对半分配）';
    return errors;
  }
  if (capacityTotal < counts.total) {
    errors.capacity_total = `总名额不得低于当前已通过人数（${counts.total} 人）`;
    return errors;
  }
  const half = capacityTotal / 2;
  const maxRoleApproved = Math.max(counts.speaker, counts.listener);
  if (half < maxRoleApproved) {
    errors.capacity_total = `总名额对半后为 ${half} 人，不得低于单一角色已通过人数（${maxRoleApproved} 人）`;
  }
  return errors;
}

/** 从活动记录取名额三字段。 */
export function capacityOf(activity: ActivityRecord): CapacityInput {
  return {
    capacity_total: activity.capacity_total,
    capacity_speaker: activity.capacity_speaker,
    capacity_listener: activity.capacity_listener,
  };
}

// ---------- 问卷状态机（PRD §4.5：draft → not_open ⇄ open → ended → archived） ----------

/** 管理员侧问卷动作；端点为 POST /api/cc/activity-surveys/:id/open|close。 */
export type AdminSurveyAction = 'open' | 'close';

export const ADMIN_SURVEY_ACTION_LABELS: Record<AdminSurveyAction, string> = {
  open: '开放填写',
  close: '结束填写',
};

/**
 * 可用动作：草稿/未开放 → 可开放；开放中 → 可结束；
 * 已结束/已归档 → 无动作（重新开放与归档不在 V1 端点契约内）。
 */
export function availableSurveyActions(status: SurveyStatus): AdminSurveyAction[] {
  switch (status) {
    case 'draft':
    case 'not_open':
      return ['open'];
    case 'open':
      return ['close'];
    // 已结束/已归档：重新开放与归档不在 V1 端点契约内
    default:
      return [];
  }
}

// ---------- 报名表配置（activities.form_config_json，database-design D-3 草案落地） ----------

/**
 * 活动级报名字段配置（PRD §8.1「标准字段启用/必填」+ 自定义字段能力）。
 * 存储于 activities.form_config_json；参与者端报名页按 enabled=true 渲染字段、
 * 按 required 做必填校验（前后端共以此结构为准，字段内容待 PRD §16.2 确认后回填）。
 */
export interface ActivityFormFieldConfig {
  field_def_id: string;
  enabled: boolean;
  required: boolean;
}

export interface ActivityFormConfig {
  fields: ActivityFormFieldConfig[];
}

/** 解析 form_config_json；空值/非法结构回退为空配置。 */
export function parseFormConfig(raw: unknown): ActivityFormConfig {
  if (raw && typeof raw === 'object' && Array.isArray((raw as ActivityFormConfig).fields)) {
    const fields = (raw as ActivityFormConfig).fields
      .filter(
        (f): f is ActivityFormFieldConfig =>
          !!f && typeof f.field_def_id === 'string' && typeof f.enabled === 'boolean',
      )
      .map((f) => ({
        field_def_id: f.field_def_id,
        enabled: f.enabled,
        required: f.enabled === false ? false : f.required === true,
      }));
    return { fields };
  }
  return { fields: [] };
}

/**
 * 合并字段定义列表与既有配置：标准字段在前、自定义在后，各组内保持传入顺序；
 * 未出现在定义里的旧配置项（如字段已停用）丢弃；新字段默认启用且采用字段的默认必填。
 */
export function mergeFormConfig(
  fieldDefIds: { id: string; required_default: boolean }[],
  existing: ActivityFormConfig,
): ActivityFormFieldConfig[] {
  const byId = new Map(existing.fields.map((f) => [f.field_def_id, f]));
  return fieldDefIds.map((def) => {
    const prev = byId.get(def.id);
    return {
      field_def_id: def.id,
      enabled: prev ? prev.enabled : true,
      required: prev ? prev.required && prev.enabled : def.required_default,
    };
  });
}

/** 更新单个字段配置；required 在 enabled=false 时强制为 false。 */
export function setFormFieldConfig(
  fields: ActivityFormFieldConfig[],
  fieldDefId: string,
  patch: Partial<Pick<ActivityFormFieldConfig, 'enabled' | 'required'>>,
): ActivityFormFieldConfig[] {
  return fields.map((f) => {
    if (f.field_def_id !== fieldDefId) return f;
    const enabled = patch.enabled ?? f.enabled;
    const required = enabled ? (patch.required ?? f.required) : false;
    return { ...f, enabled, required };
  });
}
