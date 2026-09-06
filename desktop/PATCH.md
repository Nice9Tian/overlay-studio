# 更新补丁:不重装就把已装的 Overlay Studio 更新到最新构建

完整安装包 296MB,里面 840MB 是 Chrome 和 ffmpeg,几乎不变;日常改动都在 `runtime/app`(几十 KB 到几 MB)和壳 exe(11MB)。
补丁机制只把**变化的文件**打成一个小 EXE:给已装的用户直接分发,自己开发时改完一行 10 秒就能在装好的程序里看到效果。

## 开发时怎么用(本机已装了 Overlay Studio)

```powershell
cd desktop
npm run prepare-runtime      # 改了 motion-playground 之后先同步到 runtime/(4 秒)
npm run patch:apply          # 出补丁 → 静默装进本机已装目录 → 逐文件核对哈希
```

改了 Rust 壳的话,先 `cd src-tauri; cargo build --release`(增量 30 秒),补丁会自动带上新的 `overlay-studio.exe`。
壳 exe 或 sidecar 不在的话脚本直接报错停下,不会出一个把它们当「已移除」的补丁。

- `npm run patch:dry` 只看差异不出包。
- `npm run patch:apply -- --restart` 装完顺手启动程序。
- `npm run patch -- --install-dir D:\某个副本` 对着别的目录(比如测试副本)算差异和应用。
- 正在运行的 Overlay Studio 会被关掉,连同它的 Node、导出用的 Chrome 和 ffmpeg —— 只关**可执行文件在安装目录下**的进程,别的副本和你自己的 Chrome 不受影响。正在导出的话成片会中断。

本机自用模式(基线是目录)有两条规矩:

- **不删任何文件。** 目录里有、构建产物里没有的文件,分不清是你放的还是旧版残留,一律保留(日志里会列出来)。
- 目录记录的 `patch-id.txt` 和实际内容对不上时(手工拷过文件、上次装到一半),出来的补丁只适用于这台机器,文件名带 `-devonly`,不要分发。

## 给用户分发补丁

用户手里是「某一版完整安装包装出来的原版」或「原版 + 若干补丁」。发行补丁必须对着**清单文件**算差异(`--release` 强制这一点),这样才能精确知道哪些文件是上一版发过、这一版不发了的,只删这些,绝不碰用户自己放的东西:

```powershell
# 1. 每次出完整安装包时,把它对应的清单存下来(和安装包一起归档)
npm run patch -- --dry-run --save-manifest releases\1.1.1\manifest.json

# 2. 之后每次要发补丁:对着上一版的清单算差异,顺手存这版的清单给下一次用
npm run patch -- --release --base releases\1.1.1\manifest.json --save-manifest releases\1.1.1-p1\manifest.json
```

产物在 `dist/patches/OverlayStudio-patch-<版本>-<时间>-<基线id>-to-<目标id>.exe`。用户双击就行:自动找到安装目录(注册表里完整安装包写的位置),关掉正在运行的程序,替换文件,完成页可以勾选「现在启动」。
命令行用法:`patch.exe /S`(静默)、`/S /RESTART`(静默并启动)、`/D=目录`(指定安装目录,必须最后一个参数、不加引号;目录别太深,NSIS 有 260 字符路径上限)。

补丁会核对目标机器的身份,不对就拒绝;静默模式不弹窗,只给退出码:

| 目标机器状态 | 核对方式 |
|---|---|
| 打过补丁 | `安装目录\patch-id.txt` 必须等于补丁的基线 id |
| 原版(没打过补丁) | `runtime\VERSIONS.json` 的 `builtAt` 必须等于基线那次完整构建的时间戳 |

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 3 | 目录里没有已装的 Overlay Studio |
| 4 | 基线不匹配 |
| 5 | 有文件写不进去(被占用)。**补丁未应用、基线不变**,关掉占用的程序重跑即可 |

链式补丁:p1 之后再发 p2,就用 p1 的 `--save-manifest` 输出当 p2 的 `--base`。用户跳版(装了原版直接打 p2)会被拒绝,这时给他完整安装包或对着原版清单另出一个累积补丁。

## 什么情况不能走补丁

Chrome for Testing、ffmpeg、Node 三样的版本变了(`VERSIONS.json` 里的标记不一致),`build-patch` 直接报错停下。这三样合起来 950MB,变了就该发完整安装包。
依赖(`node_modules`)变了可以走补丁,只带变化的文件,一般几 MB 到几十 MB。

## 补丁不碰的东西

清单里永远没有这些,所以不送也不删:

- `runtime/app/src/assets/fonts/`(字体)、`runtime/app/public/_media/`(导入的素材)、`runtime/app/public/_fxframes/`(视频抽帧缓存)
- `runtime/app/public/demo/`(用户上传的录屏;随包发的 README.txt / demo-overlay.json / demo.srt 除外)、`runtime/app/public/sfx/`(音效)
- `runtime/app/exports/`、`runtime/app/node_modules/.vite/`(Vite 缓存)
- `runtime/app/lint-rules.local.json`(个人 lint 阈值)
- `runtime/chrome/`、`runtime/ffmpeg/`(只比版本标记)

**除此之外,用户自己往 `runtime/app/` 里放的文件,发行补丁不会删**(删除项只来自上一版清单),但也不保证保留 —— 同名文件会被覆盖。

## 文件

| 文件 | 作用 |
|---|---|
| `scripts/patch-manifest.mjs` | 给「构建产物」或「已装目录」拍指纹快照(相对路径 + sha256),两边结构一样才能 diff;校验路径合法性 |
| `scripts/build-patch.mjs` | 算差异 → 暂存变化的文件 → 从模板生成 NSIS 脚本 → makensis 出 EXE → 可选 `--apply` 并逐文件核对 |
| `patch/patch.nsi.tmpl` | 补丁 EXE 的 NSIS 模板;`@名字@` 是占位符 |
| 安装目录里的 `patch-id.txt` / `patch-manifest.json` / `patch-info.json` / `patch-log.txt` | 补丁写下的当前状态、完整清单、本次更新了什么、历史记录 |

makensis 用 Tauri CLI 装的那份(`%LOCALAPPDATA%\tauri\NSIS\makensis.exe`),不用另装。

## 已知限制

- 完整安装包的卸载程序只认它自己装进去的文件。补丁**新增**的文件(比如 `runtime/app/dist/`)卸载时会留下。
  根治办法是给 `tauri.conf.json` 加 NSIS 卸载钩子,在卸载前 `RMDir /r "$INSTDIR\runtime"`,这同时也能解决 Vite 缓存残留。
- 补丁 EXE 没有签名,用户会看到 SmartScreen「未知发布者」,也无法分辨真补丁和伪造的。补丁本身不联网;要走网络分发,至少一起公布 sha256。
- 补丁不改注册表里的版本号(DisplayVersion),「程序和功能」里看到的还是完整安装包的版本;真正的状态看 `patch-log.txt`。
- 杀进程那一步靠 PowerShell(通过 WOW64 重定向关闭后调用 64 位版本)。没有 PowerShell 的机器上这步会跳过,如果程序正在运行,补丁会因为文件被占用以退出码 5 停下,基线不变。
- 只做了 Windows。
