# backend/ — PocketBase 后端

Chat Circles 后端为单个 PocketBase 实例：认证、业务 API、collection API rules、`pb_hooks` 服务端业务规则、SQLite 存储（technical-design §5.1）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `pb_migrations/` | 全部 schema 变更（集合、字段、索引、API rules），版本化管理。**schema 只能经迁移变更**，禁止在生产环境用 admin UI 手工改结构。当前为空（M0）。 |
| `pb_hooks/` | 全部服务端业务规则（JS）。入口 `main.pb.js` 当前注册 `GET /api/cc/health` 返回 `{"ok": true}`，作为 hooks 可运行的证明；后续按领域分文件（`auth.pb.js`、`registrations.pb.js` 等），共享函数入 `pb_hooks/lib/`。 |
| `tests/` | 服务端集成测试占位（L3：起真实 PocketBase 实例 + 迁移 + fixture，见 test-plan §3）。 |
| `pb_public/` | 前端 build 产物放置处（部署期由 Docker 构建填充，PocketBase 同源伺服），不入库。 |

## 本地启动

1. 下载 PocketBase 二进制（版本与 CI/Docker 一致，见根目录 `.env.example` 的 `PB_VERSION`）：

   ```sh
   # macOS (Apple Silicon)；其他平台替换 darwin_arm64 为 linux_amd64 等
   curl -L -o /tmp/pb.zip \
     "https://github.com/pocketbase/pocketbase/releases/download/v0.28.4/pocketbase_0.28.4_darwin_arm64.zip"
   unzip /tmp/pb.zip -d backend/
   ```

2. 启动（在本目录 `backend/` 下执行）：

   ```sh
   ./pocketbase serve --dir pb_data
   ```

   - API 与前端静态资源：<http://127.0.0.1:8090>
   - 健康检查（hooks 自定义端点）：<http://127.0.0.1:8090/api/cc/health> → `{"ok":true}`
   - 管理后台：<http://127.0.0.1:8090/_/>
   - 首次启动自动应用 `pb_migrations/` 中的全部迁移。

## 不入库约定

以下内容由 `.gitignore` 排除，**不得提交**：

- `pocketbase` 二进制（按平台各自下载）
- `pb_data/`（SQLite 数据文件与上传文件）
- `pb_public/` 中的构建产物
