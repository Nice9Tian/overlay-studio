import { useState, useEffect, useMemo, useRef } from "react";
import { AiPanel } from "../components/AiPanel";
import { connectMcpExecutor, type EditorApi, type EditorStateForAi } from "./mcpExecutor";
import { type OverlayCard, type OverlayDoc, trackOf } from "../overlay/types";
import { listPresets, subscribePresets } from "../overlay/presets";
import { listSrtAssets, listVideoAssets } from "../library/assets";
import type { SrtLine } from "../overlay/srt";

export function AiDevHarness() {
  const [doc, setDoc] = useState<OverlayDoc>({
    version: 1,
    cards: [
      { id: "c1", kind: "punch-pill", track: 1, start: 1.0, end: 5.0, params: {} },
      { id: "c2", kind: "term-card", track: 2, start: 2.0, end: 6.0, params: {} },
    ],
    cam: undefined
  });
  
  const [playing, setPlaying] = useState(false);
  const [curT, setCurT] = useState(0);
  const [mcpStatus, setMcpStatus] = useState({ connected: false });
  const [presets, setPresets] = useState(() => listPresets());
  const [srtLines, setSrtLines] = useState<SrtLine[]>([]);
  const [srtName, setSrtName] = useState<string>("");
  const [openSetupSignal, setOpenSetupSignal] = useState(0);

  useEffect(() => {
    return subscribePresets(() => setPresets(listPresets()));
  }, []);

  const apiRef = useRef<EditorApi | null>(null);
  apiRef.current = useMemo(() => ({
    getState: (): EditorStateForAi => ({
      curT,
      duration: 60,
      playing,
      trackCount: 3,
      cards: doc.cards.map(c => ({
        id: c.id, kind: c.kind, name: c.kind, start: c.start, end: c.end, track: trackOf(c), summary: ""
      })),
      videoAssets: listVideoAssets(),
      srtAssets: listSrtAssets().map(s => ({ id: s.id, name: s.name, lines: s.lines.length, duration: 0 }))
    }),
    getCard: (id) => doc.cards.find(c => c.id === id),
    addCard: (a) => {
      const id = "card-" + Date.now();
      const newCard: OverlayCard = {
        id,
        kind: a.kind as string,
        track: typeof a.track === "number" ? a.track : 1,
        start: typeof a.start === "number" ? a.start : 0,
        end: typeof a.end === "number" ? a.end : 5,
        params: a.params as any || {}
      };
      setDoc(prev => ({ ...prev, cards: [...prev.cards, newCard] }));
      return { id, start: newCard.start, end: newCard.end, track: newCard.track! };
    },
    updateCard: (p) => {
      setDoc(prev => ({
        ...prev,
        cards: prev.cards.map(c => c.id === p.id ? { ...c, ...p, params: { ...c.params, ...(p.params as any) } } as any : c)
      }));
    },
    removeCard: (id) => {
      setDoc(prev => ({ ...prev, cards: prev.cards.filter(c => c.id !== id) }));
    },
    importSrt: (name, lines, use) => {
      setSrtName(name); // Use name
      if (use) {
        setSrtLines(lines);
      }
      return { id: "mock-srt-" + Date.now() };
    },
    registerVideo: (a) => {
      return { id: "mock-vid-" + Date.now(), url: a.url as string };
    },
    seek: (t) => setCurT(t),
    setPlaying: (b) => setPlaying(b)
  }), [doc, curT, playing]);

  useEffect(() => {
    return connectMcpExecutor(() => apiRef.current!, setMcpStatus);
  }, []);

  const isMock = typeof window !== "undefined" && window.location.search.includes("mock=1");

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", backgroundColor: "var(--bg-app)" }}>
      <div style={{ flex: 1, padding: 20, overflow: "auto", color: "var(--ink)" }}>
        <h2>假编辑台 (Mock Editor)</h2>
        <div style={{ marginBottom: 20 }}>
          {isMock && <div style={{ color: "var(--ink-muted)", fontSize: 12, marginBottom: 8 }}>带 mock=1 参数时用假数据,三家 CLI 状态各不相同,API 直连未配置。</div>}
          <strong>MCP Status: </strong>
          <span style={{ color: mcpStatus.connected ? "var(--accent)" : "var(--danger)" }}>
            {mcpStatus.connected ? "Connected" : "Disconnected"}
          </span>
          <button style={{ marginLeft: 12, padding: "4px 8px", background: "var(--fill-subtle)", color: "var(--ink)", border: "1px solid var(--hairline)", borderRadius: 4, cursor: "pointer" }} onClick={() => setOpenSetupSignal(s => s + 1)}>打开 AI 设置</button>
        </div>
        
        <h3>Cards on Timeline</h3>
        <table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ borderBottom: "1px solid var(--hairline)" }}>ID</th>
              <th style={{ borderBottom: "1px solid var(--hairline)" }}>Kind</th>
              <th style={{ borderBottom: "1px solid var(--hairline)" }}>Track</th>
              <th style={{ borderBottom: "1px solid var(--hairline)" }}>Time</th>
              <th style={{ borderBottom: "1px solid var(--hairline)" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {doc.cards.map(c => (
              <tr key={c.id}>
                <td>{c.id}</td>
                <td>{c.kind}</td>
                <td>{trackOf(c)}</td>
                <td>{c.start} - {c.end}</td>
                <td><button onClick={() => apiRef.current?.removeCard(c.id)}>Del</button></td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ marginTop: 20 }}>SRT: {srtName} ({srtLines.length})</h3>
        <table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ borderBottom: "1px solid var(--hairline)" }}>Start</th>
              <th style={{ borderBottom: "1px solid var(--hairline)" }}>End</th>
              <th style={{ borderBottom: "1px solid var(--hairline)" }}>Text</th>
            </tr>
          </thead>
          <tbody>
            {srtLines.map((l, i) => (
              <tr key={i}>
                <td>{l.start}</td>
                <td>{l.end}</td>
                <td>{l.text}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ marginTop: 20 }}>Presets</h3>
        <ul>
          {presets.map(p => (
            <li key={p.id}>{p.name} ({p.kind})</li>
          ))}
        </ul>
      </div>
      
      <div style={{ width: 340, borderLeft: "1px solid var(--hairline)", backgroundColor: "var(--bg-panel)" }}>
        <AiPanel mcpConnected={mcpStatus.connected} mock={isMock} openSetupSignal={openSetupSignal} />
      </div>
    </div>
  );
}
