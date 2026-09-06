# 第三方许可 / Third-Party Licenses

这份清单只覆盖安装包里随附的东西，Overlay Studio 本体的授权见仓库根目录的 LICENSE。

### 1. Node.js
- **版本**：以 `runtime/VERSIONS.json` 的 `node` 字段为准（本机构建验证的是 v24.19.0）。
- **许可类型**：Node.js 本体 MIT。但发行版还捆了 OpenSSL、ICU、V8、libuv 等许可。
- **许可文本在包里的位置**：壳只抄了单个 node.exe 到 `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`，**按 DESIGN.md 的组装脚本步骤，Node 的 LICENSE 文件没有被一起复制进包**。
- **分发注意事项**：MIT 要求保留版权声明和许可全文，建议在 prepare-runtime 里把构建机 Node 安装目录的 LICENSE 复制成 `runtime/node-LICENSE.txt`。这条**分发前请补上**。

### 2. Chrome for Testing
- **版本**：150.0.7871.24（由 puppeteer 钉死，不能换版本，作者实测 151 存在渲染 Bug）。
- **许可类型**：Google 的条款，不是开源许可。包里有 ABOUT 文件声明 Copyright 2026 Google LLC。
- **许可文本在包里的位置**：`runtime/chrome/chrome/win64-150.0.7871.24/chrome-win64/ABOUT`。
- **分发注意事项**：把约 420MB 的 Chrome for Testing 二进制打进第三方安装包再分发，是否符合 Google 的条款，**未核实，分发前请确认**。
  - *替代方案*：改成首次运行时用 `npx puppeteer browsers install` 现下，不进安装包（**未核实**）。

### 3. ffmpeg
- **版本**：9.0.1 (Gyan.dev full build)
- **许可类型**：**GPL 构建**（配置包含 `--enable-gpl` 和 `--enable-version3`）。
- **许可文本在包里的位置**：`runtime/ffmpeg/LICENSE` 和 `runtime/ffmpeg/README.txt`。
- **分发注意事项**：随包分发 GPL 二进制必须(1)附 GPL 全文，(2)向接收方提供对应版本的完整源码或书面的源码获取 offer。建议在文档里给出 [gyan.dev 构建页](https://www.gyan.dev/ffmpeg/builds/) 和 [FFmpeg 官方源码站](https://ffmpeg.org/download.html)，并写明用的是哪个确切构建标识。
  - *替代方案*：换成 LGPL 构建（去掉 `--enable-gpl`）。但 LGPL 构建能不能满足本项目的编码需求（ProRes 4444 透明 MOV），**未核实**。
  - *额外注意*：Overlay Studio 本体是通过 spawn 调独立的 ffmpeg 进程，一般认为属于聚合而非衍生作品，但和 GPL 二进制装在同一个安装包里对本体授权（禁止商业再分发）有没有影响，没有法律意见，**未核实，分发前请确认**。

### 4. Tauri 及其 Rust 依赖
- **版本**：Tauri 2.x, CLI 版本 2.11.4。
- **许可类型**：Tauri 本身是 MIT 或 Apache-2.0 双授权。其引入的几百个 Rust crate 绝大多数是 MIT/Apache-2.0/BSD，但**没有逐一核实**。
- **许可文本在包里的位置**：目前没有生成聚合许可清单。
- **分发注意事项**：建议构建时跑 `cargo install cargo-about` 然后 `cargo about generate` 出一份 `THIRD-PARTY-rust.html` 放进包里。完整 crate 清单**未核实**。

### 5. WebView2
- **版本**：Microsoft Edge WebView2 Runtime。
- **许可类型**：Microsoft 专有许可。
- **许可文本在包里的位置**：无。**不随包分发**，由用户系统提供或经 downloadBootstrapper 下载。
- **分发注意事项**：因为不随包，一般不需要附许可文本；但微软的 WebView2 Runtime 分发条款是否对 downloadBootstrapper 这种引导安装另有要求，**未核实**。

### 6. motion-playground 自身和它的 npm 依赖
- **版本**：1.1.1。
- **许可类型**：主要依赖有 React 19(MIT)、Vite(MIT)、puppeteer(Apache-2.0) 等。
- **许可文本在包里的位置**：`runtime/app/node_modules/<包名>/LICENSE`。
- **分发注意事项**：`runtime/app/node_modules` 整体进包。但上百个包各自的具体许可情况**没有逐一核实**。

### 7. 不随包的东西 (字体和音效)
中文字体和音效文件不打进包，原因是授权——很多标着免费商用的素材并不允许随软件再分发，「你能用」和「我能转给你」是两回事。这条和命令行版的做法一致。

---

## 分发前的检查清单

- [ ] **Node.js**: 分发前请补上 Node 的 LICENSE 文件到包中。
- [ ] **Chrome for Testing (分发条款)**: 未核实，分发前请确认是否符合 Google 条款。
- [ ] **Chrome for Testing (替代方案)**: 未核实首次运行时现下的方案可行性。
- [ ] **ffmpeg (LGPL 替代)**: 未核实 LGPL 构建能否满足 ProRes 4444 的编码需求。
- [ ] **ffmpeg (授权影响)**: 未核实，分发前请确认 GPL 二进制同包对本体授权的影响。
- [ ] **Tauri / Rust 依赖**: 几百个 crate 的许可并未逐一核实，完整 crate 清单未核实。
- [ ] **WebView2**: 未核实微软对 downloadBootstrapper 这种引导安装方式是否有特殊条款。
- [ ] **npm 依赖**: 上百个 npm 包的许可并没有逐一核实。
