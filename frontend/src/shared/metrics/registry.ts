/**
 * 看板指标注册表骨架（technical-design §5.6、FR-DASH-005）。
 *
 * 设计目标：新增指标不需要重构页面与数据表——
 * 看板页面 = 顶部筛选条 + 指标配置数组的渲染结果，不出现写死的单指标卡片。
 * 新增一个指标的成本 = 本注册表加一条配置 + 服务端加一个聚合函数
 * （约定 GET /api/cc/metrics/:metric_key，筛选参数同 query）。
 *
 * 口径红线：看板口径与导出口径一致（FR-DASH-002）；
 * 去重指标界面必须注明「去重参与账号数」及多账号不合并的口径说明（PRD §7.1）。
 */

/** 指标 key：V1 初始 8 项见 technical-design §5.6；新增指标在此追加。 */
export type MetricKey =
  | 'activity_sessions'
  | 'applications'
  | 'approvals'
  | 'rejections'
  | 'service_visits'
  | 'unique_participants'
  | 'survey_submissions'
  | 'survey_completion_rate';

/** 展示形态：指标卡 / 趋势 / 角色拆分 / 活动明细表。 */
export type MetricDisplayType = 'card' | 'trend' | 'role_split' | 'table';

/** 聚合方式（PRD §7.2 要求的配置维度之一）。 */
export type MetricAggregation = 'count' | 'countDistinct' | 'ratio';

/** 筛选项定义（看板顶部筛选条按此渲染；服务端按身份注入机构范围）。 */
export interface MetricFilter {
  /** 筛选参数名（随 query 传给聚合端点）。 */
  key: string;
  label: string;
  type: 'date_range' | 'organization' | 'activity_role';
}

/** 指标配置（PRD §7.2：metric_key、dataSource、aggregation、filters、displayType）。 */
export interface MetricDefinition {
  metricKey: MetricKey;
  /** 卡片标题。 */
  title: string;
  /** 数据来源（聚合查询基于的业务对象，供实现与口径核对参考）。 */
  dataSource: string;
  aggregation: MetricAggregation;
  /** 该指标支持的筛选项；空数组表示仅受全局筛选条控制。 */
  filters: MetricFilter[];
  displayType: MetricDisplayType;
  /** 口径说明（原文口径来自 PRD §7.1）。 */
  description: string;
  /** 界面需要额外注明的口径提示（如去重口径）。 */
  note?: string;
}

/**
 * V1 指标注册表初始项（口径原文来自 PRD §7.1，见 technical-design §5.6 表）。
 * 去重指标必须保留 note 中的口径说明（AC-15）。
 */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    metricKey: 'activity_sessions',
    title: '活动场次',
    dataSource: 'activities',
    aggregation: 'count',
    filters: [],
    displayType: 'card',
    description: '筛选范围内处于已发布/已关闭/已归档的活动数；草稿、待审核、已驳回不计。',
  },
  {
    metricKey: 'applications',
    title: '报名申请数',
    dataSource: 'registrations',
    aggregation: 'count',
    filters: [{ key: 'activity_role', label: '角色', type: 'activity_role' }],
    displayType: 'card',
    description: 'registration 记录总数；可按倾诉者/聆听者拆分。',
  },
  {
    metricKey: 'approvals',
    title: '已通过报名',
    dataSource: 'registrations',
    aggregation: 'count',
    filters: [],
    displayType: 'card',
    description: '当前状态=已通过的报名数；取消后不计、回退恢复后重新计入。',
  },
  {
    metricKey: 'rejections',
    title: '已拒绝报名',
    dataSource: 'registrations',
    aggregation: 'count',
    filters: [],
    displayType: 'card',
    description: '当前状态=已拒绝的报名数；无候补。',
  },
  {
    metricKey: 'service_visits',
    title: '服务人次',
    dataSource: 'checkins',
    aggregation: 'count',
    filters: [],
    displayType: 'card',
    description: '有效签到记录数（一个账号三场活动计 3 人次）。',
  },
  {
    metricKey: 'unique_participants',
    title: '去重参与人数',
    dataSource: 'checkins',
    aggregation: 'countDistinct',
    filters: [],
    displayType: 'card',
    description: '有效签到中的 participant_id 去重。',
    note: '去重参与账号数：同一自然人多账号不合并（PRD §5.7、§7.1）。',
  },
  {
    metricKey: 'survey_submissions',
    title: '有效答卷数',
    dataSource: 'submissions',
    aggregation: 'count',
    filters: [],
    displayType: 'card',
    description: '有效已提交答卷数；作废不计。',
  },
  {
    metricKey: 'survey_completion_rate',
    title: '问卷完成率',
    dataSource: 'submissions / registrations',
    aggregation: 'ratio',
    filters: [],
    displayType: 'card',
    description:
      '有效提交人数 ÷ 符合填写资格人数；资格=当前报名已通过（剔除已取消）且角色符合问卷适用范围；开放时间不影响最终分母。',
  },
];

/** 按 key 查指标配置；未注册返回 undefined（渲染方应跳过并告警，不得静默渲染空卡）。 */
export function getMetricDefinition(key: MetricKey): MetricDefinition | undefined {
  return METRIC_DEFINITIONS.find((d) => d.metricKey === key);
}

/** 全部已注册指标（看板页面按数组渲染）。 */
export function listMetricDefinitions(): readonly MetricDefinition[] {
  return METRIC_DEFINITIONS;
}
