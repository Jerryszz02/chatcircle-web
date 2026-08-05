// lib/http.pb.js — 统一错误响应、身份守卫与通用查询辅助（jsonError / requireAuth）
//
// 契约（technical-design §5.4/§5.5、security-privacy §5.2）：
// - jsonError(e, status, code, message)：按统一错误形态返回
//   { code: <http status>, message, data: { code: <稳定机器码> } }，
//   前端 shared/api/http.ts 的 normalizeApiError 读取 message 与 data。
// - requireAuth(e, role)：校验当前请求身份属于指定角色集合，失败经 ccError 抛出，
//   由 handler 顶层 catch 转为与 jsonError 相同的响应形态。
//
// ⚠️ 重要集成说明（PocketBase 0.28.4 实测）：
// 1. JSVM 各 hooks 文件作用域完全隔离，顶层 var/function/const/globalThis 均不跨文件
//    可见，亦无 ES module 支持；本文件是契约的「标准源」，调用方将所需函数原样
//    内联到自己的 handler 闭包内使用（后端 A/B 四个领域文件均按此模式集成）。
// 2. new ApiError(status, message, data) 的第三参数会被当作字段错误映射转换，
//    无法携带自定义 data；因此 ccError 抛出「标记对象」，路由 handler 须用统一的
//    顶层 catch 转为 jsonError 响应（见本文件 ccError 注释与 CC_HANDLE_ERROR 用法）。
// 3. JSON 类型字段经 record.get() 读出为 Go []byte（桥接为字节数组），须
//    String() 化后 JSON.parse（见 ccJson）。
//
// 机构停用拦截（FR-ORG-001）：requireAuth(e, 'admin') 同时校验管理员账号 status
// 与所属机构 status 均为 active，机构停用后其管理员的一切管理端点调用在此被拒。

/**
 * 返回 JSON 错误响应（统一形态 + data.code 稳定机器码）。
 * 用于直接 return 的场景；需要中断流程（含事务回滚）时请改用 ccError 抛出。
 */
function jsonError(e, status, code, message) {
  return e.json(status, { code: status, message: message, data: { code: code } });
}

/**
 * 抛出统一错误标记对象（在 runInTransaction 内抛出会触发回滚，属性原样传播）。
 * 路由 handler 顶层必须用如下 catch 转为 jsonError 响应（后端 A 各 handler 已内置）：
 *   } catch (err) {
 *     if (err && err.__ccError === true) {
 *       return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
 *     }
 *     throw err;
 *   }
 */
function ccError(status, code, message) {
  throw { __ccError: true, status: status, code: code, message: message };
}

/**
 * 身份守卫：校验当前请求持有指定角色的有效会话。
 * @param {object} e 路由请求事件
 * @param {string} role 'participant' | 'admin' | 'super'
 * @returns {object} 认证记录（admin 调用方可经 auth.get('organization_id') 取本机构）
 */
function requireAuth(e, role) {
  const auth = e.auth;
  if (!auth) {
    ccError(401, 'UNAUTHORIZED', '请先登录');
  }
  const collectionName = auth.collection().name;
  if (role === 'participant') {
    if (collectionName !== 'participant_accounts') {
      ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
    }
    if (auth.get('status') !== 'active') {
      ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
    }
    return auth;
  }
  if (role === 'admin') {
    if (collectionName !== 'admin_accounts') {
      ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
    }
    if (auth.get('status') !== 'active') {
      ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
    }
    // 机构停用后其管理员不能进入业务后台（FR-ORG-001），历史数据保留
    const org = ccFindByIdOrNull(e.app, 'organizations', auth.get('organization_id'));
    if (!org || org.get('status') !== 'active') {
      ccError(403, 'ORG_DISABLED', '所属机构已停用');
    }
    return auth;
  }
  if (role === 'super') {
    if (collectionName !== '_superusers') {
      ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
    }
    return auth;
  }
  ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
}

/** 当前时间的 PocketBase 日期格式字符串（date 字段写入与过滤比较统一用此格式）。 */
function ccNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
}

/** 是否为「查无记录」错误（JSVM 中 find* 查无记录会抛出而非返回 null）。 */
function ccIsNoRowsError(err) {
  return !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
}

/** 按 id 查询，不存在返回 null（不抛出）。 */
function ccFindByIdOrNull(app, collection, id) {
  try {
    return app.findRecordById(collection, id);
  } catch (err) {
    if (ccIsNoRowsError(err)) return null;
    throw err;
  }
}

/** 按过滤器查单条，不存在返回 null（不抛出）。 */
function ccFindOneOrNull(app, collection, filter, params) {
  try {
    return app.findFirstRecordByFilter(collection, filter, params || {});
  } catch (err) {
    if (ccIsNoRowsError(err)) return null;
    throw err;
  }
}

/** 过滤计数（V1 单场数百人规模，物化后取长度足够；上限 5000 防误用）。 */
function ccCount(app, collection, filter, params) {
  return app.findRecordsByFilter(collection, filter, '', 5000, 0, params || {}).length;
}

/** 是否为字段唯一约束冲突（唯一索引兜底并发时的回退判定）。 */
function ccIsUniqueViolation(err) {
  return !!err && typeof err.message === 'string' && /unique/i.test(err.message);
}

/** JSON 字段读取：record.get() 对 JSON 类型返回 Go []byte，须 String 化后解析。 */
function ccJson(val, fallback) {
  try {
    const v = JSON.parse(String(val == null ? '' : val));
    return v == null ? fallback : v;
  } catch (err) {
    return fallback;
  }
}
