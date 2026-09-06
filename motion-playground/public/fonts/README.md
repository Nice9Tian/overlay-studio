# public/fonts/ · 自托管的 IBM Plex Mono

这里放的是 **界面与动效内置的** 字体(区别于 `src/assets/fonts/`,那个目录是给用户
自己丢字体用的、构建期扫描、不进安装包)。

## 为什么不用 Google Fonts 的 `<link>` 了

导出有两条路,以前它们拿到的字形不一样:

- **服务器模式**(命令行、`npm run dev`):Chrome 联网,真的会把 `fonts.gstatic.com`
  上的 woff2 下下来用上。
- **静态模式**(桌面壳,`scripts/export-frames.mjs` 的 F 节):请求拦截器把所有
  非 `overlay.local` 的请求 `abort()` 掉 —— 设计目标就是**断网也能导出**。
  于是 mono 字重的文字(kicker 之类)整段退回系统等宽字体。

同一份编排、同一台机器,两种模式导出的 PNG 因此稳定地对不上。字体自托管之后两边
拿到同一份字形,顺带让离线安装的桌面版也有正确字体。

## 内容

| 文件 | 说明 |
|---|---|
| `ibm-plex.css` | `index.html` 引它。内容是 Google Fonts `css2` 响应的原样落地:family / weight / `unicode-range` 分片全部照抄,只把 `src` 换成本地路径 |
| `ibm-plex-mono/*.woff2` | 15 个分片(400/500/600 × latin / latin-ext / vietnamese / cyrillic / cyrillic-ext),共约 149KB |

`IBM Plex Sans SC` 不在这里:它**不是 Google Fonts 的字族**(单独请求 `css2` 会返回
400),原来那行 `<link>` 里带着它也没有任何效果,中文一直走 `--font-sans` 里的系统
字体回退。这次没有改变这一点。

## 怎么再生成 / 加字重

原样重跑一次 `css2` 请求,把每个 `@font-face` 里的 woff2 抓到 `ibm-plex-mono/`、
把 `src` 改成本地路径即可(15 个分片是按 `unicode-range` 切的,不能合并成一个文件,
否则中英混排会整份下载)。请求时的 `User-Agent` 必须是现代浏览器,否则 Google 会发
`ttf` 而不是 `woff2`。

## 授权

IBM Plex 采用 **SIL Open Font License 1.1**,允许随软件一起分发。
上游:<https://github.com/IBM/plex> · 许可证全文:<https://openfontlicense.org/>
