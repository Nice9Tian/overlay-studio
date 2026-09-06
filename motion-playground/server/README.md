# Overlay Studio 服务端 

此目录包含 AI 助手后端集成，包括 Vite 插件、MCP 服务和 STT 集成。

## 端点
* `GET /api/ai/providers` - 获取可用的运行器及 STT 状态。注意: 返回的结构为 `{ ok, providers, stt }`，而不是直接在 provider 列表内部包含 stt（如最初契约所述的 `stt` 嵌套结构）。这是由于合并实现带来的微小差异。
* `POST /api/ai/chat` - 发送 AI 对话请求（SSE 流式响应）。
* `POST /api/ai/abort` - 中止指定的对话请求。
* `GET /api/mcp/events` - 编辑台连接到 MCP 的 SSE 事件流。
* `POST /api/mcp/result` - 编辑台返回的 MCP 工具执行结果。
* `POST /api/mcp/call` - MCP server 向编辑台请求工具调用。
* `GET /api/mcp/status` - 获取当前 MCP 连接状态（调试用）。

## 环境变量开关
- `OVERLAY_AI_FAKE_RUNNER`: 设为 `1` 时，强制加载内置的 `server/test/fake-runner.mjs`（用于测试流程，避免消耗真实 API 的 Token）。
- `OVERLAY_AI_RUNNER_MODULE`: 指定动态加载 runner 的路径（默认 `./runners/index.mjs`）。如果指定的 runner 加载失败或不存在，调用接口将返回 503 错误，并说明 Runner 未就绪。

## 端口发现顺序
1. 环境变量 `OVERLAY_STUDIO_PORT`。
2. `%TEMP%\overlay-studio\port.json`。
3. 默认 5177。

## 运行测试
- mcp-smoke 冒烟测试：
  ```bash
  node server/test/mcp-smoke.mjs
  ```
- 综合端到端验证测试：
  ```bash
  node server/test/p1-verify.mjs
  ```

## 语音识别（STT）配置
引擎按以下顺序优先级选择：
1. 环境变量 `OVERLAY_STT_CMD`。
2. `%LOCALAPPDATA%\overlay-studio\stt.json` 里的 `cmd` 字段。
3. 自动检测 `cuda_Vit` conda 环境中的 `faster-whisper`。
4. 若未找到，默认提示需安装 `faster-whisper`。
