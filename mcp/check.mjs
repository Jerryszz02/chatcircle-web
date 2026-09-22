import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Run against the installed server; credentials are inherited, never printed.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./server.js', import.meta.url))],
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  stderr: 'pipe',
});
// Drain logs without forwarding backend responses that could contain sensitive data.
transport.stderr?.resume();
const client = new Client({ name: 'chatcircle-installer', version: '1.0.0' });
let stage = '登录并连接 MCP';
try {
  await client.connect(transport, { timeout: 15000 });
  stage = '检查工具列表';
  const { tools } = await client.listTools({}, { timeout: 15000 });
  for (const name of ['list_activities', 'export_activity_data', 'upload_report']) {
    if (!tools.some((tool) => tool.name === name)) throw new Error('missing tool');
  }
  stage = '读取活动';
  const result = await client.callTool({ name: 'list_activities', arguments: { limit: 1 } }, undefined, { timeout: 15000 });
  if (result.isError) throw new Error('tool failed');
  console.log('验证通过：已登录，3 个工具可用，活动读取成功。');
} catch {
  console.error(`验证失败（${stage}）。请检查后端地址、网络和服务账号；未注册客户端。`);
  process.exitCode = 1;
} finally {
  await client.close();
}
