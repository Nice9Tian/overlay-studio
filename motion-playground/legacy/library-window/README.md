# 归档:素材库独立窗口版(2026-09-06)

这里是「素材库作为独立窗口 / 全屏浮层」那一版的完整代码,**不参与编译**(tsconfig 只包含 src/),留作参考和随时复活。

## 它是什么

- `LibraryWindow.tsx / .css`:窗口本体。左列动效卡(搜索 / 标签 / 分组,可拖到时间轴)+ 视频素材 + 字幕素材;右侧预览器 + 动作栏 + 右下角「…」滑出参数面板;选中字幕素材时右侧换成句子列表。
  两种宿主:`embedded`(网页 single 模式,编辑台里的全屏浮层,动作走 props 回调)和独立窗口(桌面壳 multi 模式,`?library=1` 页面,动作走 bus)。
- `LibraryPreview.tsx / .css`:预览器,播放 / 暂停 / 停止 + 可拖时间轴。靠接管 `window.__fxExportMs`(导出用的虚拟时钟)让动效卡按预览时钟走,卸载时 `delete`。**同一个 window 里只能挂一个,而且会冻住页面上其它动效卡** —— 这也是它不能直接搬进编辑台页面当悬停预览的原因。
- `LibrarySubtitles.tsx / .css`:字幕素材列表 + 句子视图。
- `mode.ts`:`libraryMode()`(桌面壳注入 `window.__OVERLAY_DESKTOP__` → multi,否则 single;`?libmode=` 可强制)、`openLibraryWindow()`(window.open 命名窗口)。
- `bus.ts`:编辑台 ↔ 素材库窗口的 BroadcastChannel 消息(add-card / set-cam / set-video / set-srt / seek / assets-changed / editor-state / hello)。
- `LIBRARY-DESIGN.md`:当时的契约和进度。

`src/library/assets.ts`(视频 / 字幕登记表)没有归档,新版素材库分页继续用它。

## 当时怎么接的线(复活时照着接)

- `src/main.tsx`:`?library=1` 路由渲染 `<EulaGate><LibraryWindow/></EulaGate>`。
- `src/App.tsx`:`libraryOpen` 状态 + `openLibrary()`(multi 时 `openLibraryWindow()`,否则置 true 渲染 `<LibraryWindow embedded …/>`);挂载时 `busSubscribe` 处理 hello / add-card / set-cam / set-video / set-srt / seek;`editorState`(trackCount / activeTrack / curT / trackNames / cardSpans / srtName)每 250ms `busSend` 一次。
- `src/components/TopBar.tsx`:「📚 素材库」按钮 → `onOpenLibrary`。
- 桌面壳(未做):lib.rs 主窗口注入 `window.__OVERLAY_DESKTOP__ = true`;on_new_window 对同源 `?library=1` 建 label 为 `library` 的 Tauri 窗口。

## 为什么归档

用户 2026-09-06 决定:素材库不做独立窗口,改成左栏的顶级分页(编辑台 / 素材库),从素材库分页把素材拖进时间轴指定位置,悬停显示预览。新版契约见 `motion-playground/LIBRARY-TAB-DESIGN.md`。
