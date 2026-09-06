import { VERSION_LABEL, VERSION_TITLE } from "../version";
import { PROMO_URL } from "../promo";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ACCENT_OPTIONS, SKIN_OPTIONS, STYLE_OPTIONS } from "../effects/hud/accent";
import { CUSTOM_FONTS } from "../fonts";
import "./TopBarPrefs.css";

// 外壳外观 = 两根正交的轴,可任意组合:
//   风格(form)  = 形状骨架,规则在 App.css 的「风格骨架」一节
//   配色(palette) = 颜色取值表,在 index.css
// 都用 "" 表示默认,和之前的皮肤 id 一个套路。
// mate = 这个风格的「原配」配色:换风格时会自动带上,除非你已经自己挑过配色
export const FORMS = [
  { id: "", name: "编辑部", hint: "直角 · 细线分区 · 按钮组熔接", mate: "" },
  { id: "ios", name: "iOS", hint: "圆角填充 · 分段控件 · 胶囊开关", mate: "blue-light" },
  // 名字点明继承关系:玻璃不是第三种骨架,是 iOS 控件语言 + 药丸圆角 + 毛玻璃材质
  { id: "glass", name: "iOS·玻璃", hint: "iOS 骨架 + 药丸圆角 + 毛玻璃 + 墙纸随配色", mate: "frost" },
  { id: "float", name: "浮岛", hint: "面板被间隙隔开 · 18px 大圆角 · iOS 控件语言", mate: "void" },
  { id: "brutal", name: "粗野主义", hint: "3px 粗边 · 硬投影 · 按下位移", mate: "light" },
  { id: "tui", name: "终端 TUI", hint: "等宽字 · 方括号按钮 · 全直角", mate: "hud" },
  { id: "material", name: "Material(谷歌)", hint: "M3 · 全圆角按钮 · 色调容器 · 控件大一档", mate: "md-violet" },
  { id: "quiet", name: "无界极简", hint: "无边框无填充 · 只靠间距和字重", mate: "forest" },
];

export const PALETTES = [
  { id: "", name: "瑞士·暗" },
  { id: "light", name: "瑞士·亮" },
  { id: "clay", name: "象牙陶土" },
  { id: "hud", name: "终端荧光" },
  { id: "pro", name: "经典灰蓝" },
  { id: "sketch", name: "线框手账" },
  { id: "frost", name: "冷灰白" },
  { id: "desert", name: "荒漠" },
  { id: "forest", name: "雾林" },
  { id: "blue-light", name: "系统蓝·浅" },
  { id: "blue-dark", name: "系统蓝·暗" },
  { id: "void", name: "深空紫" },
  { id: "md-violet", name: "Material 紫" },
];

/* 旧的单轴皮肤 id → 两轴取值。localStorage 里存的是老值时迁移一次。
   ios-glass 拆开后就是「玻璃 + 系统蓝·浅」,不再需要单独一套。 */
export const LEGACY_SKIN_MAP: Record<string, { form: string; palette: string }> = {
  "": { form: "", palette: "" },
  "swiss-light": { form: "", palette: "light" },
  clay: { form: "", palette: "clay" },
  hud: { form: "", palette: "hud" },
  pro: { form: "", palette: "pro" },
  sketchbook: { form: "", palette: "sketch" },
  karelia: { form: "", palette: "forest" },
  glass: { form: "glass", palette: "frost" },
  p58: { form: "glass", palette: "desert" },
  ios: { form: "ios", palette: "blue-light" },
  "ios-dark": { form: "ios", palette: "blue-dark" },
  "ios-glass": { form: "glass", palette: "blue-light" },
};

interface TopBarProps {
  /* 编辑台(播放/归零/声音和当前时间已挪到画面下方的 StageControls) */
  shown: number;
  total: number;
  /** 编排体检:密度 + 同屏峰值(无卡时 null) */
  stats: { peak: number; perMin: number } | null;
  selCardId: string | null;
  onImportJson: (file: File | null) => void;
  onLoadDemo: () => void;
  /* 通用 */
  exporting: boolean;
  hasVideo: boolean;
  /** 视频正在落盘:按钮要变灰。传一条几百 MB 的口播要几十秒,
      不变灰的话界面像是没反应,人会再点一次 —— 那一次点击正是后台崩溃的触发点 */
  videoBusy: boolean;
  onVideo: (file: File | null) => void;
  onExport: () => void;
  /* 外壳外观:风格(形状) × 配色(颜色),两根轴各自独立 */
  form: string;
  onForm: (id: string) => void;
  palette: string;
  onPalette: (id: string) => void;
  /* 偏好设置(齿轮面板) */
  hasDoc: boolean;
  font: string;
  onFont: (f: string) => void;
  glow: boolean;
  onToggleGlow: () => void;
  inkColor: string;
  onInkColor: (c: string) => void;
  onUnifyAccent: (accent: string) => void;
  /** 编排底色:所有卡片亮/暗(存 doc.theme) */
  theme: "dark" | "light" | undefined;
  onGlobalTheme: (theme: "dark" | "light") => void;
  /** 皮肤 / 风格 / 侧边色块(存 doc.skin / doc.style / doc.sideColor;空串 = 默认) */
  skin: string;
  onSkin: (s: string) => void;
  docStyle: string;
  onDocStyle: (s: string) => void;
  sideColor: string;
  onSideColor: (c: string) => void;
  /** 视频画面缩放(只影响画布预览,不进 JSON) */
  videoScale: number;
  onVideoScale: (v: number) => void;
  /** 导出编排 JSON */
  onExportJson: () => void;
}

function usePrefsPopover() {
  const [activePanel, setActivePanel] = useState<"style" | "display" | null>(null);
  // 面板用 fixed 定位:顶栏为了防横向溢出设了 overflow-x:hidden,而 CSS 规定
  // 一个方向非 visible 时另一个方向的 visible 会被强制算成 auto —— 于是纵向
  // 照样裁,面板在 DOM 里、位置也对,就是画不出来。fixed 的包含块是视口,不受
  // 祖先 overflow 影响,位置开面板时按按钮算。
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 52, left: 12 });
  const prefsRef = useRef<HTMLDivElement>(null);
  // 面板 portal 到了 body,不再是 prefsRef 的后代 —— 判「点到外面」时得单独认它,
  // 否则点面板里任何一处都会把自己关掉
  const popRef = useRef<HTMLDivElement>(null);
  const btnStyleRef = useRef<HTMLButtonElement>(null);
  const btnDisplayRef = useRef<HTMLButtonElement>(null);

  const togglePanel = (panel: "style" | "display") => {
    if (activePanel === panel) {
      setActivePanel(null);
    } else {
      const btn = panel === "style" ? btnStyleRef : btnDisplayRef;
      const r = btn.current?.getBoundingClientRect();
      if (r) setPos({ top: Math.round(r.bottom + 6), left: Math.round(r.left) });
      setActivePanel(panel);
    }
  };

  useEffect(() => {
    if (!activePanel) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!prefsRef.current?.contains(t) && !popRef.current?.contains(t)) setActivePanel(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setActivePanel(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [activePanel]);
  
  return { activePanel, setActivePanel, prefsRef, popRef, btnStyleRef, btnDisplayRef, togglePanel, pos };
}

/* 顶栏放不下时,读数按「整格」藏,不能切半个字。
   ——切一半会正好切在按钮组左边缘,看起来像按钮压住了数字(实测反馈)。
   格子自己不参与压缩(nowrap + 自然宽度),所以量到的位置和裁没裁无关,
   直接比右边缘就知道谁露在外面;用 visibility 藏是为了留住布局,
   下次量还是同一份坐标,不会藏一格→变宽→又该显示→抖起来。
   DOM 顺序 Time→Cards→Density→Peak→Sel 正好是重要性顺序,溢出从右边掉,
   丢的就是最不重要的那格。 */
function useMeterFit() {
  const meterRef = useRef<HTMLDivElement>(null);
  // 不给依赖数组:每次重渲染都重量一遍(格子会随卡片/选中动态增减)
  useEffect(() => {
    const m = meterRef.current;
    if (!m) return;
    const fit = () => {
      const edge = m.getBoundingClientRect().right;
      for (const cell of Array.from(m.children) as HTMLElement[]) {
        cell.style.visibility = cell.getBoundingClientRect().right <= edge + 0.5 ? "" : "hidden";
      }
    };
    fit();
    // 换风格时父组件的 effect 才刚把 data-form 写到 <html> 上,而子组件的 effect
    // 比父组件先跑 —— 这一帧量到的还是旧样式,下一帧补量一次才是新控件尺寸
    const raf = requestAnimationFrame(fit);
    const ro = new ResizeObserver(fit);
    ro.observe(m);
    window.addEventListener("resize", fit);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  });
  return meterRef;
}

/**
 * 通栏仪表条(A1 瑞士编辑部):品牌字标 + 读数模块 + 熔接按钮组。
 * 读数全部等宽字;信号橙只给「正在发生的事」:密度、选中卡、主按钮。
 */
export function TopBar({
  shown,
  total,
  stats,
  selCardId,
  onImportJson,
  onLoadDemo,
  exporting,
  hasVideo,
  videoBusy,
  onVideo,
  onExport,
  form,
  onForm,
  palette,
  onPalette,
  hasDoc,
  font,
  onFont,
  glow,
  onToggleGlow,
  inkColor,
  onInkColor,
  onUnifyAccent,
  theme,
  onGlobalTheme,
  skin,
  onSkin,
  docStyle,
  onDocStyle,
  sideColor,
  onSideColor,
  videoScale,
  onVideoScale,
  onExportJson,
}: TopBarProps) {
  const { activePanel, prefsRef, popRef, btnStyleRef, btnDisplayRef, togglePanel, pos } = usePrefsPopover();
  const meterRef = useMeterFit();
  // 当前风格的原配配色 —— 只用来在下拉里打个「原配」标记,换不换由 App 决定
  const mate = FORMS.find((f) => f.id === form)?.mate ?? "";
  const videoRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  return (
    <div className="topbar">
      <div className="tb-brand">
        OVERLAY<em>/</em>STUDIO
        <span className="tb-ver" title={VERSION_TITLE}>{VERSION_LABEL}</span>
      </div>

      {/* 编辑台 / 素材库的切换搬去了左栏顶部的顶级分页,顶栏不再有模式按钮 */}
      {/* 版本指南入口。放在字标的紧右边 —— 眼睛本来就扫这一片,
          又不混进右边那排干活的按钮(那儿每次导出都会看到,容易烦)。
          地址为空(专业版 / dev)时整个不渲染。 */}
      {PROMO_URL ? (
        <a
          className="tb-pro"
          href={PROMO_URL}
          target="_blank"
          rel="noreferrer"
          title="看基础版和专业版差在哪,以及怎么联系作者"
        >
          看专业版 ↗
        </a>
      ) : null}

      {/* 读数模块 */}
      <div className="tb-meter" ref={meterRef}>
        {total > 0 && (
          <div className="tb-cell">
            <span className="tb-k">Cards</span>
            <span className="tb-v">
              {shown}<i>/{total}</i>
            </span>
          </div>
        )}
        {stats && (
          <div className="tb-cell" title="编排体检:目标 10-16 张/分钟">
            <span className="tb-k">Density</span>
            <span className="tb-v">
              <b>{stats.perMin.toFixed(1)}</b>
              <i>/min</i>
            </span>
          </div>
        )}
        {stats && (
          <div className="tb-cell" title="同屏峰值:建议 ≤4">
            <span className="tb-k">Peak</span>
            <span className="tb-v">{stats.peak}</span>
          </div>
        )}
        {selCardId && (
          <div className="tb-cell">
            <span className="tb-k">Sel</span>
            <span className="tb-v tb-v--acc">{selCardId}</span>
          </div>
        )}
      </div>

      <span className="tb-flex" />

      {/* 熔接按钮组 */}
      <div className="tb-group">
        <div className="tb-prefs" ref={prefsRef}>
          {/* 全局风格:存进编排文件,导出时生效 */}
          <button
            ref={btnStyleRef}
            className={`tb-gear ${activePanel === "style" ? "is-on" : ""}`}
            onClick={() => togglePanel("style")}
            title="全局风格"
            aria-expanded={activePanel === "style"}
          >
            🎨 全局风格
          </button>
          {/* 显示设置:只影响本机编辑台预览,不进文件 */}
          <button
            ref={btnDisplayRef}
            className={`tb-gear ${activePanel === "display" ? "is-on" : ""}`}
            onClick={() => togglePanel("display")}
            title="显示设置"
            aria-expanded={activePanel === "display"}
          >
            🖥 显示设置
          </button>
          
          {/* 挂到 body 上,不能留在顶栏里:「玻璃」风格给 .topbar 加了 backdrop-filter,
              带 filter 的元素会变成后代 fixed 的包含块 —— 面板于是相对顶栏定位、
              又被顶栏的 overflow:hidden 裁成一道白边,看起来就是「设置拉不下来」
              (实测反馈)。 */}
          {activePanel === "style" &&
            createPortal(
              <div className="tb-prefs-pop" ref={popRef} style={{ top: pos.top, left: pos.left }}>
                <div className="tb-prefs-kicker">存进编排文件,导出时生效</div>

                <div className="tb-prefs-row">
                  <span>全局底色</span>
                  <div className="seg">
                    <button
                      className={`seg-btn ${theme !== "light" ? "is-on" : ""}`}
                      onClick={() => onGlobalTheme("dark")}
                      disabled={!hasDoc}
                    >
                      🌙 暗底
                    </button>
                    <button
                      className={`seg-btn ${theme === "light" ? "is-on" : ""}`}
                      onClick={() => onGlobalTheme("light")}
                      disabled={!hasDoc}
                    >
                      🌞 亮底
                    </button>
                  </div>
                </div>

                <div className="tb-prefs-row tb-prefs-row--col">
                  <span>全局主色</span>
                  <div className="tb-swatches">
                    {ACCENT_OPTIONS.map((a) => (
                      <button
                        key={a.value}
                        className={`tb-sw acc-${a.value}`}
                        title={`把所有卡的强调色统一成「${a.label}」`}
                        onClick={() => onUnifyAccent(a.value)}
                        disabled={!hasDoc}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <div className="tb-prefs-hint">
                    {hasDoc ? "点一下改写所有卡的强调色,可撤销" : "先加卡片或导入编排"}
                  </div>
                </div>

                <div className="tb-prefs-row">
                  <span>全局文字色</span>
                  <span className="tb-prefs-ctl">
                    <input
                      type="color"
                      value={inkColor || "#ffffff"}
                      onChange={(e) => onInkColor(e.target.value)}
                      disabled={!hasDoc}
                    />
                    <button className="tb-mini" onClick={() => onInkColor("")} disabled={!hasDoc || !inkColor}>
                      恢复皮肤默认
                    </button>
                  </span>
                </div>

                <div className="tb-prefs-row">
                  <span>全局字体</span>
                  <select
                    className="tb-prefs-ctl"
                    value={font}
                    onChange={(e) => onFont(e.target.value)}
                    disabled={!hasDoc}
                  >
                    <option value="">默认(IBM Plex Sans SC)</option>
                    {CUSTOM_FONTS.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </div>

                <div className="tb-prefs-row">
                  <span>文字光晕(发虚就关)</span>
                  <button
                    className={`switch ${glow ? "is-on" : ""}`}
                    role="switch"
                    aria-checked={glow}
                    onClick={onToggleGlow}
                    disabled={!hasDoc}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>

                <div className="tb-prefs-row">
                  <span>皮肤</span>
                  <select
                    className="tb-prefs-ctl"
                    value={skin}
                    onChange={(e) => onSkin(e.target.value)}
                    disabled={!hasDoc}
                  >
                    {SKIN_OPTIONS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="tb-prefs-row">
                  <span>风格</span>
                  <select
                    className="tb-prefs-ctl"
                    value={docStyle}
                    onChange={(e) => onDocStyle(e.target.value)}
                    disabled={!hasDoc}
                  >
                    {STYLE_OPTIONS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>

                {docStyle === "sketch" && (
                  <div className="tb-prefs-row">
                    <span>侧边色块</span>
                    <span className="tb-prefs-ctl">
                      <input
                        type="color"
                        className="tbp-color-input"
                        value={sideColor || "#f09a3e"}
                        onChange={(e) => onSideColor(e.target.value)}
                        disabled={!hasDoc}
                      />
                      <button className="tb-mini" onClick={() => onSideColor("")} disabled={!hasDoc}>
                        清除
                      </button>
                    </span>
                  </div>
                )}

                {/* 口播视频(doc.cam)搬去了素材库:视频素材 →「设为口播视频」 */}
              </div>,
              document.body,
            )}

          {activePanel === "display" &&
            createPortal(
              <div className="tb-prefs-pop" ref={popRef} style={{ top: pos.top, left: pos.left }}>
                <div className="tb-prefs-kicker">只影响这台电脑上的编辑台,不进文件</div>

                <div className="tb-prefs-row">
                  <span>编辑台风格</span>
                  <select
                    className="tb-prefs-ctl"
                    value={form}
                    onChange={(e) => onForm(e.target.value)}
                    title="风格:换编辑台的形状骨架(圆角/边框/控件长相),不影响导出画面"
                  >
                    {FORMS.map((f) => (
                      <option key={f.id} value={f.id} title={f.hint}>
                        ◱ {f.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="tb-prefs-row">
                  <span>编辑台配色</span>
                  <select
                    className="tb-prefs-ctl"
                    value={palette}
                    onChange={(e) => onPalette(e.target.value)}
                    title="配色:换编辑台的颜色,不影响导出画面。任何配色都能配任何风格"
                  >
                    {PALETTES.map((c) => (
                      <option key={c.id} value={c.id}>
                        🎨 {c.name}
                        {c.id === mate ? " · 原配" : ""}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 安全区参考线 / 人物占位两个开关挪到了画面下方的播放操作栏(StageControls):
                    它们是「看画面时顺手切」的东西,放在画面旁边比藏在面板里顺手 */}

                <div className="tb-prefs-row">
                  <span>视频画面缩放</span>
                  <span className="tb-prefs-ctl">
                    <input
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.05}
                      value={videoScale}
                      onChange={(e) => onVideoScale(Number(e.target.value))}
                    />
                    <span className="tbp-val">{Math.round(videoScale * 100)}%</span>
                  </span>
                </div>
              </div>,
              document.body,
            )}
        </div>
        <button className="tb-btn" onClick={() => jsonRef.current?.click()}>
          导入 JSON
        </button>
        <button className="tb-btn" onClick={onExportJson} disabled={!hasDoc}>
          📤 导出 JSON
        </button>
        <button className="tb-btn" onClick={onLoadDemo} title="载入内置演示编排,不需要自己的视频">
          🎬 示例
        </button>
        <button
          className="tb-btn"
          disabled={videoBusy}
          onClick={() => videoRef.current?.click()}
        >
          {videoBusy ? "⏳ 上传中…" : hasVideo ? "换视频" : "导入视频"}
        </button>
        <button className="tb-btn tb-btn--primary" onClick={onExport} disabled={exporting}>
          {exporting ? "导出中…" : "⬇ 导出透明 MOV"}
        </button>
      </div>

      <input
        ref={jsonRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          onImportJson(e.target.files?.[0] ?? null);
          if (jsonRef.current) jsonRef.current.value = "";
        }}
      />
      <input
        ref={videoRef}
        type="file"
        accept="video/*"
        style={{ display: "none" }}
        onChange={(e) => {
          onVideo(e.target.files?.[0] ?? null);
          if (videoRef.current) videoRef.current.value = "";
        }}
      />
    </div>
  );
}
