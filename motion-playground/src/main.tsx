import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ExportView } from './ExportView.tsx'
import { EulaGate } from './EulaGate.tsx'
import { CrashGate } from './CrashGate.tsx'

// ?export=1 → 导出专用纯净视图(透明底,仅动效,供无头浏览器逐帧截图)
// 素材库不再是独立窗口,它是左栏的一个顶级分页(见 LIBRARY-TAB-DESIGN.md)
const isExport = new URLSearchParams(location.search).get('export') === '1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashGate>
      {isExport ? <ExportView /> : <EulaGate><App /></EulaGate>}
    </CrashGate>
  </StrictMode>,
)
