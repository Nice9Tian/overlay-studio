import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ExportView } from './ExportView.tsx'
import { EulaGate } from './EulaGate.tsx'
import { CrashGate } from './CrashGate.tsx'
import { AiDevHarness } from './ai/AiDevHarness.tsx'

// ?export=1 → 导出专用纯净视图(透明底,仅动效,供无头浏览器逐帧截图)
// 素材库不再是独立窗口,它是左栏的一个顶级分页(见 LIBRARY-TAB-DESIGN.md)
// ?aidev=1 → AI 助手的开发用页面:假编辑台 + 聊天面板(&mock=1 不打后端;见 AI-ASSISTANT-DESIGN.md §5.5)
const search = new URLSearchParams(location.search)
const isExport = search.get('export') === '1'
const isAiDev = search.get('aidev') === '1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashGate>
      {isExport ? <ExportView /> : isAiDev ? <AiDevHarness /> : <EulaGate><App /></EulaGate>}
    </CrashGate>
  </StrictMode>,
)
