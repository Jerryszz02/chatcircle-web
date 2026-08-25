// Chat Circles — metrics.pb.js：看板指标聚合 hooks（后端 B）
// 职责（technical-design §5.6、PRD §7、FR-DASH-001/002/004/005）：
// - GET /api/cc/metrics/{metric_key}?from&to&organization_id&activity_status&activity_role
//   按 metric_key 分发到对应聚合函数；新增指标 = 注册表加一条配置 + 本文件加一个聚合函数，
//   页面结构与数据表结构不变（FR-DASH-005）。
// - 机构范围注入（FR-DASH-001、FR-ORG-006）：管理员恒为本机构（忽略客户端 organization_id），
//   超级管理员可全平台并按 organization_id 筛选；筛选统一作用于全部指标（FR-DASH-004）。
// - 口径红线（technical-design §5.6，原文来自 PRD §7.1）：
//   activity_sessions       范围内处于已发布/已关闭/已归档的活动数（草稿、待审核、已驳回不计）
//   applications            报名记录总数（可按 activity_role 拆分）
//   approvals               当前状态=已通过的报名数（取消后不计、回退恢复后重新计入）
//   rejections              当前状态=已拒绝的报名数
//   service_visits          有效签到记录数（服务人次；一个账号三场活动计 3 人次）
//   unique_participants     有效签到中的 participant_id 去重（同一自然人多账号不合并）
//   survey_submissions      有效已提交答卷数（作废不计）
//   survey_completion_rate  有效提交人数 ÷ 符合填写资格人数；资格=当前报名已通过（剔除已取消）
//                           且角色符合问卷适用范围；分子同样只计报名当前仍为已通过的提交；
//                           开放时间不影响最终分母
// - 时间筛选 from/to 采用重叠口径：活动 [start_time, end_time] 与筛选区间有交集即计入
//   （先圈定活动范围，再聚合其关联记录），与导出口径保持一致（FR-DASH-002）。
//
// 实现注意（PocketBase 0.28 JSVM 实测）：handler 在请求期以全新作用域执行，文件级函数/常量
// 对 handler 不可见，故全部工具函数与指标注册表内联在 handler 内。

routerAdd('GET', '/api/cc/metrics/{metricKey}', (e) => {
    // --- 内联共享 lib（JSVM 各 hooks 文件作用域完全隔离，lib 为「标准源」契约须内联使用，
  //     与 lib/http.pb.js 同实现；见 lib/audit.pb.js 顶部集成说明）---
  const jsonError = (e, status, code, message) => e.json(status, { code: status, message, data: { code } });
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'participant') {
      if (collectionName !== 'participant_accounts') ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      return auth;
    }
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      // 机构停用后其管理员不能进入业务后台（FR-ORG-001），历史数据保留
      let org = null;
      try {
        org = e.app.findRecordById('organizations', auth.get('organization_id'));
      } catch (_) {
        org = null;
      }
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };

  const iso = (s) => (s ? String(s).replace(' ', 'T') : '');

  // 分页取全量
  const queryAll = (collection, filter, params, sort) => {
    const out = [];
    const pageSize = 500;
    let offset = 0;
    for (;;) {
      const page = $app.findRecordsByFilter(collection, filter, sort || '', pageSize, offset, params || {});
      if (!page || page.length === 0) break;
      out.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    return out;
  };
  const inFilter = (field, ids) => {
    const params = {};
    const parts = ids.map((id, i) => {
      params['k' + i] = id;
      return `${field} = {:k${i}}`;
    });
    return { filter: parts.join(' || '), params };
  };

  // --- 鉴权：管理员或超级管理员 ---
  let auth = null;
  let role = null;
  try {
    auth = requireAuth(e, 'admin');
    role = 'admin';
  } catch (_) {
    try {
      auth = requireAuth(e, 'super');
      role = 'super';
    } catch (err) {
      return jsonError(e, 401, 'unauthorized', '需要机构管理员或超级管理员登录');
    }
  }

  const query = e.requestInfo().query || {};

  // from/to 接受两种形态，非法格式 400：
  // - 纯日期 YYYY-MM-DD：UTC 自然日边界（from 含当日 00:00 起、to 拼当日 23:59:59.999 止，
  //   原语义不变，exports 等既有调用方不受影响）；
  // - 完整 datetime（PB 空格 `YYYY-MM-DD HH:mm:ss.sssZ` 或 ISO `T` 形式）：归一化为 PB 空格
  //   格式后按精确边界比较，from 含、to 不含（左闭右开，与前端 localDayToPbUtcRange 输出
  //   契约一致——看板指标卡片与下钻明细由此共用同一时区口径）。
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const parseBound = (v) => {
    if (typeof v !== 'string') return null;
    if (DATE_RE.test(v)) return { day: v };
    if (DATETIME_RE.test(v)) return { dt: v.replace('T', ' ') };
    return null;
  };
  const fromBound = query.from ? parseBound(query.from) : null;
  if (query.from && !fromBound) {
    return jsonError(e, 400, 'validation_failed', 'from 须为 YYYY-MM-DD 或完整 datetime（YYYY-MM-DD HH:mm:ss.sssZ）格式');
  }
  const toBound = query.to ? parseBound(query.to) : null;
  if (query.to && !toBound) {
    return jsonError(e, 400, 'validation_failed', 'to 须为 YYYY-MM-DD 或完整 datetime（YYYY-MM-DD HH:mm:ss.sssZ）格式');
  }

  // 机构范围注入：管理员恒为本机构（忽略客户端传入的 organization_id，FR-ORG-006）；
  // 超级管理员可全平台或按机构筛选（FR-DASH-001）
  let orgId = null;
  if (role === 'admin') {
    orgId = auth.get('organization_id');
  } else if (query.organization_id) {
    try {
      $app.findRecordById('organizations', query.organization_id);
      orgId = query.organization_id;
    } catch (_) {
      return jsonError(e, 400, 'validation_failed', 'organization_id 无效');
    }
  }

  // 范围内活动：机构注入 + activity_status + 时间范围（重叠口径：
  // 活动 [start_time, end_time] 与筛选区间有交集即计入，而非仅按 start_time 单点落入）
  let filter = '';
  const params = {};
  if (orgId) {
    filter = 'organization_id = {:o}';
    params.o = orgId;
  }
  if (query.activity_status) {
    filter = filter ? filter + ' && status = {:st}' : 'status = {:st}';
    params.st = query.activity_status;
  }
  let activities = queryAll('activities', filter, params, 'created');
  // end_time 缺失时退化为 start_time（瞬时活动），避免空串比较把活动错误纳入/排除
  const endIso = (a) => iso(a.get('end_time')) || iso(a.get('start_time'));
  const endRaw = (a) => String(a.get('end_time') || a.get('start_time'));
  if (fromBound) {
    // from 含边界：活动结束时间早于 from 才排除
    activities = fromBound.day
      ? activities.filter((a) => endIso(a) >= fromBound.day)
      : activities.filter((a) => endRaw(a) >= fromBound.dt);
  }
  if (toBound) {
    // to：纯日期为当日结束（含），datetime 不含边界；活动开始时间晚于 to 才排除
    activities = toBound.day
      ? activities.filter((a) => iso(a.get('start_time')) <= toBound.day + 'T23:59:59.999Z')
      : activities.filter((a) => String(a.get('start_time')) < toBound.dt);
  }
  const activityIds = activities.map((a) => a.id);

  // 惰性数据访问器（按指标需要取数，统一应用角色筛选）
  const cache = {};
  const ctx = {
    activities,
    registrations() {
      if (!cache.registrations) {
        let regs = [];
        if (activityIds.length > 0) {
          const f = inFilter('activity_id', activityIds);
          regs = queryAll('registrations', f.filter, f.params, 'created');
        }
        if (query.activity_role) {
          regs = regs.filter((r) => r.get('activity_role') === query.activity_role);
        }
        cache.registrations = regs;
      }
      return cache.registrations;
    },
    validCheckins() {
      if (!cache.validCheckins) {
        let list = [];
        if (activityIds.length > 0) {
          const f = inFilter('activity_id', activityIds);
          list = queryAll('checkins', `(${f.filter}) && status = 'valid'`, f.params, 'created');
        }
        if (query.activity_role) {
          // 签到表无角色字段：经 registration_id 反查报名角色
          const regRoleMap = {};
          ctx.registrations().forEach((r) => {
            regRoleMap[r.id] = r.get('activity_role');
          });
          list = list.filter((c) => regRoleMap[c.get('registration_id')] === query.activity_role);
        }
        cache.validCheckins = list;
      }
      return cache.validCheckins;
    },
    surveys() {
      if (!cache.surveys) {
        let list = [];
        if (activityIds.length > 0) {
          const f = inFilter('activity_id', activityIds);
          list = queryAll('activity_surveys', f.filter, f.params, 'created');
        }
        cache.surveys = list;
      }
      return cache.surveys;
    },
    submittedSubmissions() {
      if (!cache.submittedSubmissions) {
        let list = [];
        const surveys = ctx.surveys();
        if (surveys.length > 0) {
          const f = inFilter('activity_survey_id', surveys.map((s) => s.id));
          list = queryAll('submissions', `(${f.filter}) && status = 'submitted'`, f.params, 'created');
        }
        if (query.activity_role) {
          const regRoleMap = {};
          ctx.registrations().forEach((r) => {
            regRoleMap[r.id] = r.get('activity_role');
          });
          list = list.filter((s) => regRoleMap[s.get('registration_id')] === query.activity_role);
        }
        cache.submittedSubmissions = list;
      }
      return cache.submittedSubmissions;
    },
  };

  // 指标注册表：metric_key → 聚合函数（新增指标只需在此加一个函数，FR-DASH-005）
  const METRICS = {
    // 已发布/已关闭/已归档的活动数（草稿、待审核、已驳回、已下架不计）
    activity_sessions() {
      return {
        value: ctx.activities.filter((a) => ['published', 'closed', 'archived'].indexOf(a.get('status')) >= 0).length,
      };
    },
    // 报名记录总数（可按角色拆分）
    applications() {
      return { value: ctx.registrations().length };
    },
    // 当前状态=已通过的报名数（取消后不计、回退恢复后重新计入）
    approvals() {
      return { value: ctx.registrations().filter((r) => r.get('status') === 'approved').length };
    },
    // 当前状态=已拒绝的报名数
    rejections() {
      return { value: ctx.registrations().filter((r) => r.get('status') === 'rejected').length };
    },
    // 有效签到记录数（服务人次）
    service_visits() {
      return { value: ctx.validCheckins().length };
    },
    // 有效签到中的 participant_id 去重（去重参与账号数；同一自然人多账号不合并，PRD §7.1）
    unique_participants() {
      const seen = {};
      ctx.validCheckins().forEach((c) => {
        seen[c.get('participant_id')] = true;
      });
      return {
        value: Object.keys(seen).length,
        note: '去重参与账号数；凭据丢失重新注册产生的新账号不合并（PRD §5.7、§7.1）',
      };
    },
    // 有效已提交答卷数（作废不计）
    survey_submissions() {
      return { value: ctx.submittedSubmissions().length };
    },
    // 有效提交人数 ÷ 符合填写资格人数；开放时间不影响最终分母
    survey_completion_rate() {
      // 分母：范围内每份问卷（草稿除外——草稿从未对参与者可见，PRD §8.2 能力层口径）
      // 的「当前报名已通过且角色匹配」人数之和
      const surveys = ctx.surveys().filter((s) => s.get('status') !== 'draft');
      const approved = ctx.registrations().filter((r) => r.get('status') === 'approved');
      const approvedByActivity = {};
      approved.forEach((r) => {
        (approvedByActivity[r.get('activity_id')] = approvedByActivity[r.get('activity_id')] || []).push(r);
      });
      let denominator = 0;
      surveys.forEach((s) => {
        const regs = approvedByActivity[s.get('activity_id')] || [];
        const scope = s.get('role_scope');
        denominator += regs.filter((r) => scope === 'both' || r.get('activity_role') === scope).length;
      });
      // 分子口径：只计报名当前仍为 approved 的提交（取消/拒绝后不计入有效提交人数）
      const approvedRegIds = {};
      approved.forEach((r) => {
        approvedRegIds[r.id] = true;
      });
      const numerator = ctx.submittedSubmissions().filter((s) => approvedRegIds[s.get('registration_id')]).length;
      return {
        value: denominator === 0 ? 0 : Math.round((numerator / denominator) * 10000) / 10000,
        numerator,
        denominator,
        note: '有效提交人数（报名当前仍为已通过）÷ 符合填写资格人数（当前报名已通过且角色匹配；剔除已取消；开放时间不影响分母）',
      };
    },
  };

  const metricKey = e.request.pathValue('metricKey');
  const metric = METRICS[metricKey];
  if (!metric) {
    return jsonError(e, 404, 'unknown_metric', '未知指标：' + metricKey + '，可选：' + Object.keys(METRICS).join(', '));
  }

  const result = metric();
  return e.json(200, {
    metric_key: metricKey,
    value: result.value,
    numerator: result.numerator,
    denominator: result.denominator,
    note: result.note,
    filters: {
      from: query.from || null,
      to: query.to || null,
      organization_id: orgId,
      activity_status: query.activity_status || null,
      activity_role: query.activity_role || null,
    },
    activity_count: activityIds.length,
  });
});
