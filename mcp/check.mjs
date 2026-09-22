import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Run the installed launcher; a handshake does not require backend login.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./launch.mjs', import.meta.url))],
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  stderr: 'pipe',
});
// Drain logs without forwarding backend responses that could contain sensitive data.
transport.stderr?.resume();
const client = new Client({ name: 'chatcircle-installer', version: '1.0.0' });
let stage = '连接 MCP';
try {
  await client.connect(transport, { timeout: 15000 });
  stage = '检查工具列表';
  const { tools } = await client.listTools({}, { timeout: 15000 });
  for (const name of ['list_activities', 'export_activity_data', 'upload_report']) {
    if (!tools.some((tool) => tool.name === name)) throw new Error('missing tool');
  }
  if (process.argv.includes('--authenticated')) {
    stage = '读取活动';
    const result = await client.callTool({ name: 'list_activities', arguments: { limit: 1 } }, undefined, { timeout: 15000 });
    if (result.isError) throw new Error('tool failed');
    console.log('验证通过：登录会话有效，活动读取成功。');
  } else {
    console.log('验证通过：MCP 已连接，3 个工具已注册；首次使用时登录。');
  }
} catch {
  console.error(`验证失败（${stage}）。请检查安装或登录状态。`);
  process.exitCode = 1;
} finally {
  await client.close();
}
