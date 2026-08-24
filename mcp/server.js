#!/usr/bin/env node
// Chat Circles MCP server — agent 数据取送通道（见 mcp/README.md）
//
// 三个 tool：
// - list_activities：列活动（activity_code/标题/状态/起止时间/机构名），供 agent 定位活动
// - export_activity_data：经现有 POST /api/cc/exports 拉取单活动规范化导出（include_pii 恒 false，
//   敏感字段过滤由服务端 is_sensitive 口径保证），ZIP 解压到本地目录后只返回文件路径与行数，
//   不回数据正文（避免撑爆 agent 上下文）
// - upload_report：把分析产出回传 reports 集合（status 恒 draft，人工审核后发布）；
//   上传文件必须位于 CC_REPORT_DIR（默认 = CC_DATA_DIR）内，防止被诱导上传任意本地文件；
//   创建审计（report.upload）由后端 reports.pb.js 钩子在保存事务内写入，本进程不单独发审计
//
// 权限边界：本进程持有超管服务账号凭据（env 注入），是唯一的权限闸门——
// 不暴露 include_pii 参数、不提供任何写业务数据的 tool、上传强制 draft。
// stdio 本地运行，不监听任何端口，公网零新增暴露。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import unzipper from 'unzipper';

// ---------- 配置（env 注入，凭据不入库）----------
const PB_URL = (process.env.CC_PB_URL || 'http://127.0.0.1:8090').replace(/\/+$/, '');
const AGENT_EMAIL = process.env.CC_AGENT_EMAIL || '';
const AGENT_PASSWORD = process.env.CC_AGENT_PASSWORD || '';
const DATA_DIR =
  process.env.CC_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
// 上传路径白名单根目录：upload_report 只接受该目录内的文件（默认 = DATA_DIR）
const REPORT_DIR = path.resolve(process.env.CC_REPORT_DIR || DATA_DIR);

if (!AGENT_EMAIL || !AGENT_PASSWORD) {
  console.error('[cc-mcp] 缺少 CC_AGENT_EMAIL / CC_AGENT_PASSWORD 环境变量');
  process.exit(1);
}

// ---------- PocketBase 客户端（超管服务账号；401 自动重登一次）----------
let authToken = null;

async function login() {
  const res = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: AGENT_EMAIL, password: AGENT_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`服务账号登录失败（HTTP ${res.status}）：${await res.text()}`);
  }
  const data = await res.json();
  authToken = data.token;
}

async function api(method, apiPath, { body, form, raw = false, _retried = false } = {}) {
  const headers = {};
  if (authToken) headers.Authorization = authToken; // PB 接受裸 token（与集成测试口径一致）
  let payload;
  if (form) {
    payload = form; // FormData：fetch 自动带 multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${PB_URL}${apiPath}`, { method, headers, body: payload });
  if (res.status === 401 && !_retried) {
    await login();
    return api(method, apiPath, { body, form, raw, _retried: true });
  }
  if (!res.ok) {
    throw new Error(`${method} ${apiPath} 失败（HTTP ${res.status}）：${await res.text()}`);
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

// ---------- 工具函数 ----------
const CODE_RE = /^[A-Za-z0-9_-]+$/;
const STATUS_RE = /^[a-z_]+$/;

async function findActivity(activityCode) {
  if (!CODE_RE.test(activityCode)) throw new Error(`activity_code 非法：${activityCode}`);
  const data = await api(
    'GET',
    `/api/collections/activities/records?perPage=1&expand=organization_id` +
      `&filter=(activity_code='${activityCode}')`,
  );
  const item = (data.items || [])[0];
  if (!item) throw new Error(`找不到活动 ${activityCode}，可先用 list_activities 查看可用活动`);
  return item;
}

// 按逻辑记录数统计 CSV 行数（减表头）：引号感知的有限状态机，
// 处理 RFC 4180 引号字段（"" 转义；引号内的 \r\n 不计为新行）——自由文本答案可含换行
function csvRows(file) {
  const text = fs.readFileSync(file, 'utf8');
  let inQuotes = false;
  let records = 0;
  let hasContent = false; // 当前记录是否有内容（避免把末尾空行当一条记录）
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++; // "" 转义
        else inQuotes = false;
      }
    } else if (ch === '"') {
      inQuotes = true;
      hasContent = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++; // \r\n 视为一个换行
      records++;
      hasContent = false;
    } else {
      hasContent = true;
    }
  }
  if (hasContent) records++; // 末尾无换行的最后一条记录
  return Math.max(records - 1, 0); // 减表头
}

function jsonContent(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

// ---------- MCP server ----------
const server = new McpServer({ name: 'chatcircle', version: '0.1.0' });

server.registerTool(
  'list_activities',
  {
    title: '列出活动',
    description:
      '列出 Chat Circles 平台上的活动（按开始时间倒序），返回 activity_code、标题、状态、起止时间、机构名。做活动数据分析前先用它定位 activity_code。',
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe('按状态过滤（published/closed/archived 等）；不传返回全部'),
      limit: z.number().int().min(1).max(200).optional().describe('返回条数，默认 50'),
    },
  },
  async ({ status, limit }) => {
    const params = new URLSearchParams({
      perPage: String(limit || 50),
      sort: '-start_time',
      expand: 'organization_id',
    });
    if (status) {
      if (!STATUS_RE.test(status)) throw new Error(`status 非法：${status}`);
      params.set('filter', `(status='${status}')`);
    }
    const data = await api('GET', `/api/collections/activities/records?${params}`);
    const items = (data.items || []).map((a) => ({
      activity_code: a.activity_code,
      title: a.title,
      status: a.status,
      start_time: a.start_time,
      end_time: a.end_time,
      organization: (a.expand && a.expand.organization_id && a.expand.organization_id.name) || '',
    }));
    return jsonContent(items);
  },
);

server.registerTool(
  'export_activity_data',
  {
    title: '导出活动数据',
    description:
      '导出指定活动的规范化数据（报名/签到/问卷答卷等 13 个 CSV，已按敏感标记脱敏、排除作废答卷），' +
      '解压到本地目录并返回各 CSV 路径与行数。数据分析请读取这些 CSV 文件，不要在对话里粘贴大表。',
    inputSchema: {
      activity_code: z.string().describe('活动代码（用 list_activities 查询），如 CC_SA_202608_01'),
    },
  },
  async ({ activity_code }) => {
    const act = await findActivity(activity_code);
    // include_pii 恒 false：agent 通道不开放敏感导出（敏感字段由服务端 is_sensitive 口径过滤）
    const job = await api('POST', '/api/cc/exports', {
      body: { scope: { type: 'activity', activity_id: act.id }, include_pii: false },
    });
    const jobId = job.export_job && job.export_job.id;
    const zip = await api('GET', `/api/cc/exports/${jobId}/download`, { raw: true });

    // 目录名含 export_job_id（全局唯一）：同活动重复导出不会撞名覆盖，且与返回值天然对应可溯源
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const outDir = path.join(DATA_DIR, `${activity_code}-${jobId}`);
    fs.mkdirSync(outDir); // 已存在即抛错（防御；jobId 唯一，正常不会发生）
    const extracted = await unzipper.Open.buffer(zip);
    await extracted.extract({ path: outDir, concurrency: 5 });

    const files = fs
      .readdirSync(outDir)
      .filter((f) => f.endsWith('.csv'))
      .sort()
      .map((f) => ({ name: f, path: path.join(outDir, f), rows: csvRows(path.join(outDir, f)) }));
    return jsonContent({
      export_job_id: jobId,
      file_checksum: job.export_job && job.export_job.file_checksum,
      activity: { activity_code, title: act.title },
      dir: outDir,
      files,
    });
  },
);

server.registerTool(
  'upload_report',
  {
    title: '上传活动报告',
    description:
      '把活动数据分析报告（pdf/md 等文件）回传到 Chat Circles 的 reports 集合，一律以 draft 入库，' +
      '由人工在管理后台审核后发布。文件必须位于允许的输出目录（CC_REPORT_DIR，默认 = CC_DATA_DIR）内。' +
      '建议在 export_activity_data 之后调用，并传回 export_job_id 以便溯源。',
    inputSchema: {
      activity_code: z.string().describe('报告所属活动代码'),
      file_path: z.string().describe('报告文件的本地路径（必须位于允许的输出目录内）'),
      title: z.string().describe('报告标题'),
      export_job_id: z.string().optional().describe('溯源：本报告基于的导出任务 id'),
      notes: z.string().optional().describe('生成元信息（分析 skill / prompt 版本等）'),
    },
  },
  async ({ activity_code, file_path, title, export_job_id, notes }) => {
    const act = await findActivity(activity_code);
    // 上传路径白名单：只接受 CC_REPORT_DIR（默认 = CC_DATA_DIR）内的文件，
    // 防止 agent 被提示词注入诱导上传任意本地文件（凭据/配置等）
    const abs = path.resolve(file_path);
    const rel = path.relative(REPORT_DIR, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`报告文件必须位于输出目录 ${REPORT_DIR} 内，收到：${abs}`);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error(`报告文件不存在：${abs}`);
    }
    const buf = fs.readFileSync(abs);
    if (buf.length === 0) throw new Error(`报告文件为空：${abs}`);

    const form = new FormData();
    form.set('title', title);
    form.set('activity_id', act.id);
    form.set('status', 'draft'); // 强制 draft，发布保留人工
    if (export_job_id) form.set('export_job_id', export_job_id);
    if (notes) form.set('notes', notes);
    form.set('file', new Blob([buf]), path.basename(abs));
    // 创建审计（report.upload）由后端 reports.pb.js 钩子在保存事务内写入
    const rec = await api('POST', '/api/collections/reports/records', { form });

    return jsonContent({
      report_id: rec.id,
      status: rec.status,
      hint: '已入库为 draft，请到管理后台审核后发布',
    });
  },
);

// ---------- 入口 ----------
async function selftest() {
  await login();
  console.log('[selftest] 服务账号登录成功：' + AGENT_EMAIL);
  const data = await api('GET', '/api/collections/activities/records?perPage=3&sort=-start_time');
  console.log('[selftest] 活动示例（至多 3 条）：');
  for (const a of data.items || []) {
    console.log(`  ${a.activity_code}  ${a.title}  [${a.status}]  ${a.start_time}`);
  }
  const col = await api('GET', '/api/collections/reports');
  console.log('[selftest] reports 集合存在：' + (col.name === 'reports'));
  console.log('[selftest] OK');
}

async function main() {
  if (process.argv.includes('--selftest')) {
    await selftest();
    return;
  }
  await login(); // 启动即验证凭据，失败直接退出
  await server.connect(new StdioServerTransport());
  console.error('[cc-mcp] 已连接（stdio），PB=' + PB_URL); // 日志走 stderr，stdout 留给 JSON-RPC
}

main().catch((err) => {
  console.error('[cc-mcp] 启动失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});
