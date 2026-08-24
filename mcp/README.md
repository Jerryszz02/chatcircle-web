# mcp/ — Chat Circles agent 数据取送 MCP server

面向 agent（Kimi Code / Claude Desktop 等 MCP 客户端）的数据通道：**取数**走后端现有导出 API
（`POST /api/cc/exports`，脱敏口径），**报告回传**入 `reports` 集合（一律 draft，人工审核后发布）。
数据分析与报告撰写不在本目录职责内（由公司内部分析 skill 完成）。

## 权限边界

- 本进程持有**超管服务账号**凭据（`CC_AGENT_EMAIL` / `CC_AGENT_PASSWORD`，env 注入、不入库），
  是唯一的权限闸门；agent 与最终用户均不接触凭据。
- `export_activity_data` 的 `include_pii` **恒为 false**（不暴露该参数），敏感字段由服务端
  `is_sensitive` 口径过滤，作废答卷不计入。
- `upload_report` 的 `status` **恒为 draft**；本 server 不提供任何写业务数据的 tool。
- stdio 本地运行，不监听端口，公网零新增暴露；拉取与上传均留审计（exports hook 自动 +
  `report.upload`）。

## 准备

```sh
cd mcp
npm install
```

服务账号（每个环境一次，凭据用强密码、不要复用人类超管凭据）：

```sh
# 本地（backend/ 下执行）；生产用同一命令指向生产 pb_data 或经 SSH 执行
./pocketbase superuser create agent@cc.local '换成强密码' --dir pb_data
```

> 注：PRD「全平台唯一超级管理员」指人类管理员产品口径；本服务账号为运维例外，
> 见 docs/planning/security-privacy.md。

## 冒烟自检

```sh
export CC_PB_URL=http://127.0.0.1:8090
export CC_AGENT_EMAIL=agent@cc.local
export CC_AGENT_PASSWORD='换成强密码'
npm run selftest   # 登录 → 列 3 个活动 → 确认 reports 集合存在
```

## 接入 MCP 客户端

Kimi Code（`~/.kimi-code/config.toml` 或项目级配置）：

```toml
[mcp_servers.chatcircle]
command = "node"
args = ["/绝对路径/chatcircleWeb/mcp/server.js"]
env = { CC_PB_URL = "http://127.0.0.1:8090", CC_AGENT_EMAIL = "agent@cc.local", CC_AGENT_PASSWORD = "换成强密码" }
```

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "chatcircle": {
      "command": "node",
      "args": ["/绝对路径/chatcircleWeb/mcp/server.js"],
      "env": {
        "CC_PB_URL": "http://127.0.0.1:8090",
        "CC_AGENT_EMAIL": "agent@cc.local",
        "CC_AGENT_PASSWORD": "换成强密码"
      }
    }
  }
}
```

生产环境把 `CC_PB_URL` 换成 `https://chatcircle.empact.cn`（agent 跑在本机、经 HTTPS 访问即可，
无需在服务器上部署任何新东西）。

## 工具与配置

| tool | 作用 |
| --- | --- |
| `list_activities(status?, limit?)` | 按开始时间倒序列活动，返回 activity_code/标题/状态/机构名 |
| `export_activity_data(activity_code)` | 导出单活动 13 个 CSV 到本地目录，返回路径与行数（不返回数据正文） |
| `upload_report(activity_code, file_path, title, export_job_id?, notes?)` | 报告文件回传 reports 集合（draft），写审计 |

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `CC_PB_URL` | `http://127.0.0.1:8090` | 后端地址 |
| `CC_AGENT_EMAIL` / `CC_AGENT_PASSWORD` | 无（必填） | 超管服务账号凭据 |
| `CC_DATA_DIR` | `mcp/data/` | 导出解压目录（已入 .gitignore） |

典型对话：「帮我整理一下 CC_XX_202608_01 这个活动的数据」→ agent 调
`export_activity_data` → 用分析 skill 处理本地 CSV 生成报告 → 调 `upload_report` 回传。
