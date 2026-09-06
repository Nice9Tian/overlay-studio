/**
 * AI 助手的测试用 Vite 配置(契约 AI-ASSISTANT-DESIGN.md §3.6):
 *   npx vite --config server/vite.ai.config.ts
 * aiBridge() 已经注册在主配置 vite.config.ts 里,这里只改端口(5196,别的会话用 5177 / 5199 / 5198 / 5197)、
 * 绑 127.0.0.1(这台机器 localhost 解析成 ::1,MCP 服务打 127.0.0.1 会连不上)、不自动开浏览器。
 */
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';

export default mergeConfig(
  base,
  defineConfig({
    server: { host: '127.0.0.1', port: 5196, strictPort: true, open: false },
  }),
);
