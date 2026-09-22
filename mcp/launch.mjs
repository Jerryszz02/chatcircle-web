#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// This file is copied beside server.js into the user's private installation.
try {
  const config = JSON.parse(fs.readFileSync(new URL('./credentials.json', import.meta.url), 'utf8'));
  for (const key of ['CC_PB_URL', 'CC_AGENT_EMAIL', 'CC_AGENT_PASSWORD', 'CC_DATA_DIR', 'CC_REPORT_DIR']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error('invalid config');
    process.env[key] = config[key];
  }
} catch {
  console.error('[chatcircle] 安装配置缺失或损坏，请重新运行安装程序。');
  process.exit(1);
}
process.argv[1] = fileURLToPath(new URL('./server.js', import.meta.url));
await import('./server.js');
