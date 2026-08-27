# mcp/ — Chat Circles agent 数据取送 MCP server

面向支持本地 STDIO MCP 的 agent（WorkBuddy / Kimi Code / Claude Desktop / Codex 等）的数据通道：
**取数**走后端现有导出 API
（`POST /api/cc/exports`，脱敏口径），**报告回传**入 `reports` 集合（一律 draft，人工审核后发布）。
数据分析与报告撰写不在本目录职责内（由公司内部分析 skill 完成）。

## 运行形态与兼容性

本目录实现的是由 MCP 客户端在 **agent 所在机器**上启动的 STDIO server，不是部署在生产服务器上的
HTTP MCP 服务：

```text
WorkBuddy / Kimi / Claude / Codex / 其他本地 agent
                    ↓ STDIO
            本机 node mcp/server.js
                    ↓ PocketBase HTTP API
              Chat Circles 后端
```

因此：

- MCP 客户端里要配置 `command` / `args` / `env`，让客户端启动本机 `server.js`；
- `CC_PB_URL` 是 Chat Circles **后端地址**，不是远程 MCP URL；不要把后端 IP 或域名填进
  Streamable HTTP / SSE MCP 的 URL 输入框；
- agent 必须能启动本地进程并读取 `CC_DATA_DIR` 中的 CSV，云端 agent 或只支持远程 HTTP MCP 的
  客户端不能直接使用当前版本；
- 同一份 server 可由不同 MCP 客户端使用，只需把下面的标准配置翻译成客户端对应格式。

## 权限边界

- 本进程持有**超管服务账号**凭据（`CC_AGENT_EMAIL` / `CC_AGENT_PASSWORD`，env 注入、不入库），
  是唯一的权限闸门；agent 与最终用户均不接触凭据。
- `export_activity_data` 的 `include_pii` **恒为 false**（不暴露该参数），敏感字段由服务端
  `is_sensitive` 口径过滤，作废答卷不计入。
- `upload_report` 的 `status` **恒为 draft**；本 server 不提供任何写业务数据的 tool。
- `upload_report` 的 `file_path` **只允许 `CC_REPORT_DIR`（默认 = `CC_DATA_DIR`）内的文件**，
  防止被诱导上传任意本地文件（凭据/配置等）。
- stdio 本地运行，不监听端口，公网零新增暴露；拉取审计由 exports hook 自动写入，
  上传审计（`report.upload`）由后端 reports.pb.js 钩子与报告保存在同一事务写入。

## 准备

```sh
cd mcp
npm ci
```

服务账号（每个环境一次，凭据用强密码、不要复用人类超管凭据）：

```sh
# 本地（backend/ 下执行）；生产用同一命令指向生产 pb_data 或经 SSH 执行
./pocketbase superuser create agent@cc.local '换成强密码' --dir pb_data

# Docker Compose 生产环境（在服务器的仓库目录执行）
docker compose exec app ./pocketbase superuser create agent@cc.local '换成强密码' --dir /pb/pb_data
```

> 注：PRD「全平台唯一超级管理员」指人类管理员产品口径；本服务账号为运维例外，
> 见 docs/planning/security-privacy.md。每个环境使用独立强密码，不复用人类超管账号；不要把真实密码
> 提交到仓库、截图或共享配置模板。

## 冒烟自检

```sh
export CC_PB_URL=http://127.0.0.1:8090
export CC_AGENT_EMAIL=agent@cc.local
export CC_AGENT_PASSWORD='换成强密码'
npm run selftest   # 登录 → 列 3 个活动 → 确认 reports 集合存在
```

## 接入 MCP 客户端

所有路径都使用绝对路径。`command` 建议填写 Node 二进制绝对路径，避免桌面应用的 `PATH` 与终端不同。

### WorkBuddy

用户级配置写入 `~/.workbuddy/mcp.json`。**不要编辑** `~/.workbuddy/.mcp.json`（带点前缀），
后者是 WorkBuddy 自动生成的连接器代理配置。

```json
{
  "mcpServers": {
    "chatcircle": {
      "type": "stdio",
      "command": "/绝对路径/node",
      "args": ["/绝对路径/chatcircleWeb/mcp/server.js"],
      "env": {
        "CC_PB_URL": "http://127.0.0.1:8090",
        "CC_AGENT_EMAIL": "agent@cc.local",
        "CC_AGENT_PASSWORD": "换成该环境的服务账号密码",
        "CC_DATA_DIR": "/绝对路径/chatcircleWeb/mcp/data",
        "CC_REPORT_DIR": "/绝对路径/chatcircleWeb/mcp/data"
      }
    }
  }
}
```

完全退出（macOS 用 `Cmd+Q`）并重新打开 WorkBuddy，在 MCP / 连接器列表中信任并启用
`chatcircle`。WorkBuddy 支持环境变量占位符时可把密码改为 `${CC_AGENT_PASSWORD}`，由运行环境
注入；若从桌面图标启动，先确认应用进程确实继承了该环境变量。

### Claude Desktop 与其他标准 JSON 客户端

Claude Desktop 的 `claude_desktop_config.json` 以及采用标准 `mcpServers` JSON 结构的客户端可直接复用
上面的 WorkBuddy server 块。客户端若不接受 `type` 字段，删除 `"type": "stdio"` 即可。

### Kimi Code / Codex 等 TOML 客户端

Kimi Code（`~/.kimi-code/config.toml` 或项目级配置）：

```toml
[mcp_servers.chatcircle]
command = "/绝对路径/node"
args = ["/绝对路径/chatcircleWeb/mcp/server.js"]
env = { CC_PB_URL = "http://127.0.0.1:8090", CC_AGENT_EMAIL = "agent@cc.local", CC_AGENT_PASSWORD = "换成该环境的服务账号密码", CC_DATA_DIR = "/绝对路径/chatcircleWeb/mcp/data", CC_REPORT_DIR = "/绝对路径/chatcircleWeb/mcp/data" }
```

Codex 使用相同的 `[mcp_servers.chatcircle]` 结构，用户级配置文件为 `~/.codex/config.toml`。

### 后端地址选择

只需按当前环境替换 `CC_PB_URL`，其余 MCP 配置不变：

| 环境 | `CC_PB_URL` | 说明 |
| --- | --- | --- |
| 本地开发 | `http://127.0.0.1:8090` | 本机 PocketBase |
| 未备案临时生产入口 | `http://106.15.44.81:8443` | IP 直连；当前为明文 HTTP，仅用于临时阶段 |
| 备案且 HTTPS 切换完成后 | `https://chatcircle.empact.cn` | 长期生产入口；切换前先验证 `/api/cc/health` |

未备案阶段更安全的做法是经 SSH 隧道访问服务器回环端口：

```sh
ssh -N -L 18090:127.0.0.1:8090 <服务器用户>@106.15.44.81
```

保持隧道终端运行，并配置：

```text
CC_PB_URL=http://127.0.0.1:18090
```

公网 `http://106.15.44.81:8443` 会明文传输服务账号凭据与导出内容；不应作为长期方案，也不要在
不可信网络中使用。

## 首次使用与验收

客户端重启后，先检查 MCP 列表中 `chatcircle` 已连接，并确认能看到这三个工具：

- `list_activities`
- `export_activity_data`
- `upload_report`

可按顺序向 agent 发送：

```text
使用 chatcircle 列出最近 10 个活动。

导出活动 CC_XX_202608_01 的脱敏数据，并告诉我每个 CSV 的行数。

分析刚才导出的报名、签到和问卷数据，生成一份 Markdown 报告，
保存到允许的报告目录并上传到后台作为草稿。
```

预期结果：

1. `list_activities` 返回可用的 `activity_code`；
2. `export_activity_data` 在 `CC_DATA_DIR/<activity_code>-<export_job_id>/` 解压 13 个 CSV，
   `manifest.csv` 中 `include_pii=false`；
3. agent 读取本地 CSV 生成报告；
4. `upload_report` 返回 `report_id` 与 `status=draft`，管理后台人工审核后再发布；
5. 后端存在导出与 `report.upload` 审计记录。

这个 MCP 不提供报名、签到、问卷等业务数据的批量导入或修改工具。这里的“回传”只指上传分析报告。

## 云端 Agent 与远程 MCP

如果目标 agent 只能连接 Streamable HTTP / SSE MCP，或 agent 运行在无法访问本机文件的云端，当前
STDIO server 不兼容。不能简单地把 `server.js` 放到公网运行，因为导出工具目前返回本地文件路径，
上传工具也依赖本地目录白名单。

未来如需支持云端 agent，应单独实现远程版本，并至少补齐：HTTPS、Bearer/OAuth 或等价鉴权、每客户端
独立服务身份、对象存储与短期签名下载链接、远程报告上传、限流和审计。完成这些改造前，优先使用
“本地 agent + STDIO server”的部署形态。

## 常见问题

- **启动即退出并提示缺少账号**：检查 `CC_AGENT_EMAIL` / `CC_AGENT_PASSWORD` 是否注入到 MCP 子进程。
- **客户端找不到 `node`**：把 `command` 改成 `command -v node` 返回的绝对路径。
- **登录失败**：先在 `mcp/` 目录用同一组环境变量运行 `npm run selftest`，确认账号和 `CC_PB_URL`。
- **上传报告被拒绝**：报告文件必须非空且位于 `CC_REPORT_DIR` 内；默认应把分析产物写进
  `CC_DATA_DIR`。
- **把 IP 配成 HTTP MCP 后无法连接**：IP 是 PocketBase 后端地址，应放进 `CC_PB_URL`；客户端仍须
  以 STDIO 方式启动本地 `server.js`。
- **换电脑后启动失败**：在新机器克隆仓库、运行 `cd mcp && npm ci`，并更新 Node、`server.js`、
  `CC_DATA_DIR` 的绝对路径。

## 工具与配置

| tool | 作用 |
| --- | --- |
| `list_activities(status?, limit?)` | 按开始时间倒序列活动，返回 activity_code/标题/状态/机构名 |
| `export_activity_data(activity_code)` | 导出单活动 13 个 CSV 到本地目录，返回路径与行数（不返回数据正文） |
| `upload_report(activity_code, file_path, title, export_job_id?, notes?)` | 报告文件回传 reports 集合（draft）；文件须位于 `CC_REPORT_DIR` 内 |

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `CC_PB_URL` | `http://127.0.0.1:8090` | 后端地址 |
| `CC_AGENT_EMAIL` / `CC_AGENT_PASSWORD` | 无（必填） | 超管服务账号凭据 |
| `CC_DATA_DIR` | `mcp/data/` | 导出解压目录（已入 .gitignore）；agent 分析产物也应写在这里 |
| `CC_REPORT_DIR` | = `CC_DATA_DIR` | `upload_report` 允许的上传根目录（防任意文件上传） |

典型对话：「帮我整理一下 CC_XX_202608_01 这个活动的数据」→ agent 调
`export_activity_data` → 用分析 skill 处理本地 CSV 生成报告 → 调 `upload_report` 回传。
