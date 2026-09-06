; Overlay Studio 的 NSIS 钩子(tauri.conf.json → bundle.windows.nsis.installerHooks)。
;
; 为什么需要卸载钩子?
; NSIS 卸载器只删它自己装进去的文件。程序跑过之后 runtime\ 里会多出运行期生成的东西:
; Vite 的依赖预构建缓存(node_modules\.vite)、卡内视频的抽帧缓存(public\_fxframes)、
; 增量补丁装进来的静态导出页(app\dist)。它们不在安装清单里,卸载后整个 runtime\ 目录
; 因为非空而留下来(2026-09-06 实测残留 2.4MB)。
;
; 为什么不整目录 RMDir /r "$INSTDIR\runtime"?
; 用户放进去的字体(runtime\app\src\assets\fonts)和导入的素材(runtime\app\public\_media)
; 也在这棵树下,那是用户自己的文件,卸载不该替他删。所以只点名删缓存类目录;
; 用户目录留着,顶层 runtime\ 非空就让它留着,卸载器不会报错。

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$INSTDIR\runtime\app\node_modules\.vite"
  RMDir /r "$INSTDIR\runtime\app\node_modules\.vite-temp"
  RMDir /r "$INSTDIR\runtime\app\public\_fxframes"
  RMDir /r "$INSTDIR\runtime\app\dist"
  RMDir /r "$INSTDIR\runtime\app\exports"
!macroend
