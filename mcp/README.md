# Chat Circles MCP：安装后首次使用时登录

为本地 MCP 客户端提供三个工具：列活动、导出脱敏 CSV、上传报告草稿。
默认连接现有网站 `https://chatcircle.empact.cn`，使用现有的 **Chat Circles 超级管理员账号**。
不需要另外创建服务账号，不需要在安装时填写密码。

## 安装

需要 Node.js 18+ 和 npm。在下载好的仓库根目录运行一条命令，按客户端选择：

```sh
node mcp/install.mjs --client codex
# 或
node mcp/install.mjs --client workbuddy
# 或（macOS / Windows）
node mcp/install.mjs --client claude
```

安装器会：

1. 把运行文件安装到 `~/.local/share/chatcircle-mcp`，自动安装依赖、识别 Node 路径；
2. 验证 MCP 握手及三个工具的注册，无需连接后端或提供账号；
3. 备份并更新客户端的 `chatcircle` 配置，保留其他设置和 MCP；
4. 提示重启客户端，并按客户端要求信任 `chatcircle`。

Codex 使用本机 `codex mcp add` 合并配置，需要 CLI 可执行。
WorkBuddy 写入 `~/.workbuddy/mcp.json`，不会编辑自动生成的 `~/.workbuddy/.mcp.json`。
Claude Desktop 使用系统对应的 `claude_desktop_config.json`。

安装后的运行文件独立于仓库，移动或删除源码不会破坏连接。
可用 `--install-dir /固定私有目录` 指定安装位置；该目录不得位于 Git 仓库内。
Node 本身路径变化时重新运行安装命令即可。

## 第一次使用

1. 对 agent 说：「使用 chatcircle 列出最近活动。」
2. 工具返回 `LOGIN_REQUIRED` 和一个本机登录链接。打开链接，在浏览器里输入你现有的超管邮箱和密码。
3. 页面显示登录成功后，回到对话重试刚才的操作；无需重启 MCP。

**不要把密码发送到聊天里，也不要让 agent 用工具参数代填密码。** 登录页面使用现有后台的
`_superusers/auth-with-password` 接口，不创建或修改账号。机构管理员和参与者账号不能替代超管账号，
因为报告集合只允许超管读写。

MCP 与网站浏览器的会话互相独立：即使网站已经登录，MCP 首次使用仍需登录一次。
登录成功后，本机只保存 token，不保存邮箱和密码。重启后会验证并复用会话；
会话过期或被后端拒绝时，再次返回登录链接。网络故障不会直接清除已保存的会话。

登录页仅临时监听 `127.0.0.1` 的随机端口，链接 10 分钟有效，成功后关闭。
页面只能在运行 MCP 的同一台电脑打开。链接过期后重试工具即可获取新链接。

## 本机文件与升级

安装目录包含：

| 文件或目录 | 用途 |
| --- | --- |
| `settings.json` | 后端地址和数据目录，不包含账号密码 |
| `session.json` | 登录成功后保存的会话 token，与后端地址绑定 |
| `data/` | 导出的 CSV 和允许上传的报告 |
| `launch.mjs` | 客户端启动入口 |

macOS / Linux 安装目录权限为 700，配置及会话文件权限为 600；Windows 依赖私人用户目录的访问控制。
**token 同样属于敏感凭据**，同一系统用户权限下的程序可读取，不要分享安装目录或提交到仓库。
它仍具有超管权限；这个版本只改变登录体验，没有建立新的受限账号体系。

重复运行安装命令会更新程序，保留数据和登录会话。会话不会跨后端地址使用。
从旧版升级时，安装器保留原后端地址，成功注册后删除旧的 `credentials.json` 密码文件，
改为首次使用时登录。旧版的 `CC_AGENT_EMAIL` / `CC_AGENT_PASSWORD` 不再用于认证。

客户端配置旁的 `.chatcircle-*.bak` 是安装前的备份，可能包含旧配置中的敏感字段，仍需保护。
安装验证失败时不会注册客户端；已有安装的运行文件或设置可能已更新。

退出或换账号：先停止所有客户端中的 `chatcircle` 进程，再删除安装目录内的 `session.json`。
重新启用后，首次使用会再次要求登录。这仅清除本机保存的会话，不声称在服务端撤销已签发 token。
卸载时先从客户端移除 `chatcircle`，备份 `data/` 后再删除安装目录。

## 后端地址与运行方式

默认使用现有 HTTPS 网站。连接本地开发环境可指定：

```sh
node mcp/install.mjs --client codex --url http://127.0.0.1:8090
```

地址优先级为 `--url`、`CC_PB_URL`、上次安装配置、默认网站地址。
远程后端必须使用 HTTPS；HTTP 只允许本机回环地址。安装器不会把账号密码或 token 发往其他主机，
认证和业务请求均不跟随重定向。生产 PocketBase 不默认向主机暴露 8090，应通过 Caddy HTTPS 入口访问。

```text
本地 Codex / WorkBuddy / Claude / Kimi
             ↓ STDIO
       本机 Chat Circles MCP
             ↓ HTTPS（登录后携带会话）
       现有 Chat Circles 后端
```

`CC_PB_URL` 是后端地址，不是远程 MCP URL。当前服务通过 STDIO 启动；
导出返回本地文件路径，上传也读取本地文件，不能直接供仅支持远程 HTTP MCP 的云端 agent 使用。

### Kimi 与其他客户端

自动安装注册支持 Codex、WorkBuddy、Claude Desktop。Kimi 使用 JSON MCP 配置，不能照抄 Codex TOML。
不同版本可能使用 `~/.kimi/mcp.json` 或 `~/.kimi-code/mcp.json`，先运行 `kimi mcp list` 确认。
若已通过安装器完成本机安装，可复用启动器：

```sh
kimi mcp add chatcircle --transport stdio -- /绝对路径/node /用户目录/.local/share/chatcircle-mcp/launch.mjs
kimi mcp test chatcircle
```

参考 [Kimi 官方 CLI 文档](https://moonshotai.github.io/kimi-cli/en/reference/kimi-mcp.html)。
其他标准 JSON 客户端可以使用以下配置块，替换实际绝对路径：

```json
{
  "mcpServers": {
    "chatcircle": {
      "command": "/绝对路径/node",
      "args": ["/用户目录/.local/share/chatcircle-mcp/launch.mjs"]
    }
  }
}
```

## 工具与权限

| 工具 | 作用 |
| --- | --- |
| `list_activities(status?, limit?)` | 按开始时间倒序列活动，返回活动代码、标题、状态、机构名 |
| `export_activity_data(activity_code)` | 通过现有导出 API 获取单活动 13 个 CSV，返回本地路径与行数 |
| `upload_report(activity_code, file_path, title, export_job_id?, notes?)` | 上传报告到 `reports` 集合，固定为草稿 |

导出的 `include_pii` 固定为 false，敏感字段遵循后端 `is_sensitive` 过滤，作废答卷不计入。
上传文件必须在允许的报告目录内（含符号链接检查），非空且不超过 20MB。
报告固定为 `draft`，由管理后台人工审核发布；上传与报告审计在同一后端事务中保存。
这三个工具不提供报名、签到、问卷等业务数据的批量导入或修改。

典型使用：列活动 → 导出 CSV → agent 使用内部分析 skill 生成报告 → 上传草稿。
安装检查只证明工具注册成功；登录后读取、导出和上传的真实业务结果需要分别验证。

## 开发验证

```sh
npm ci --prefix mcp
npm test --prefix mcp
```

测试使用临时用户目录和 fixture 后端，覆盖无账号安装、旧版升级、首次登录、错误密码、
跨来源/Host 拒绝、链接过期、会话复用/失效、真实 MCP 工具重试和配置保留。
测试不会修改真实客户端配置，也不连接生产数据。有 Codex CLI 时额外验证其真实配置合并。

安装目录中的 `node check.mjs` 验证握手和工具列表；登录后可运行 `node check.mjs --authenticated`
验证活动读取。直接开发运行 `server.js` 时可设置 `CC_PB_URL`、`CC_DATA_DIR`、`CC_REPORT_DIR`、
`CC_SESSION_FILE`；后两者默认分别为数据目录和 `mcp/session.json`。
不要把会话文件放到允许上传的报告目录中。
