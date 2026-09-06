import React, { useRef, useState, useEffect } from "react";
import "./AiPanel.css";
import { useAiChat } from "../ai/useAiChat";
import { renderLiteMarkdown } from "../ai/liteMarkdown";
import { importVideoFile, importSrtFile } from "../library/assets";
import type { ChatAttachment } from "../ai/types";

export function AiPanel(props: { mcpConnected: boolean; hotkeysOff?: boolean; mock?: boolean }) {
  const { messages, providers, provider, setProvider, streaming, send, abort, newChat, error, setMessages } = useAiChat({ mock: props.mock });
  const [inputText, setInputText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = messagesScrollRef.current;
    if (el) {
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (isAtBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [messages, streaming]);

  useEffect(() => {
    const onAiError = (e: any) => setToast(e.detail);
    window.addEventListener("ai-chat-error", onAiError);
    return () => window.removeEventListener("ai-chat-error", onAiError);
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const handleSend = () => {
    if (!inputText.trim() && attachments.length === 0) return;
    send(inputText.trim(), attachments);
    setInputText("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "36px";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (props.hotkeysOff) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setToast(`正在导入 ${file.name}...`);
    try {
      if (file.name.endsWith(".srt")) {
        const text = await file.text();
        const srtAsset = await importSrtFile(file);
        setAttachments(prev => [...prev, {
          url: "", 
          name: file.name,
          kind: "srt",
          text,
          durationSec: srtAsset.lines.length ? srtAsset.lines[srtAsset.lines.length - 1].end : 0
        }]);
        setToast(null);
      } else if (file.type.startsWith("video/") || file.name.endsWith(".mp4")) {
        const videoAsset = await importVideoFile(file);
        setAttachments(prev => [...prev, {
          url: videoAsset.src,
          name: file.name,
          kind: "video",
          durationSec: videoAsset.durationSec
        }]);
        setToast(null);
      } else if (file.name.endsWith(".json")) {
        const text = await file.text();
        setAttachments(prev => [...prev, {
          url: "",
          name: file.name,
          kind: "json",
          text
        }]);
        setToast(null);
      } else {
        setToast("不支持的文件类型");
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        setToast(err.message || "导入失败");
      } else {
        setToast("导入失败");
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const toggleTool = (msgId: string, toolIdx: number) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId || !m.tools) return m;
      const tools = [...m.tools];
      tools[toolIdx] = { ...tools[toolIdx], expanded: !tools[toolIdx].expanded };
      return { ...m, tools };
    }));
  };

  if (providers.length > 0 && !providers.some(p => p.available)) {
    return (
      <aside className="panel panel-right ai-panel">
        <div className="ai-panel-header">
          <div className="ai-panel-title">AI 助手</div>
        </div>
        <div className="ai-empty-state">
          没找到 Claude Code / agy / Codex,装好任意一个后重启本地服务
        </div>
      </aside>
    );
  }

  return (
    <aside className="panel panel-right ai-panel">
      <div className="ai-panel-header">
        <div className="ai-panel-title">
          <span>AI 助手</span>
          <div 
            className={`ai-status-dot ${props.mcpConnected ? "is-connected" : ""}`}
            title={props.mcpConnected ? "已连接编辑台 MCP" : "未连接编辑台 MCP"}
          />
        </div>
        <div className="ai-panel-controls">
          <select 
            className="ai-provider-select"
            value={provider || ""}
            onChange={e => setProvider(e.target.value as any)}
          >
            {providers.map(p => (
              <option key={p.id} value={p.id} disabled={!p.available} title={p.available ? "" : "未安装"}>
                {p.id === "claude" ? "Claude Code" : p.id === "agy" ? "Antigravity" : p.id === "codex" ? "Codex" : p.label}
              </option>
            ))}
          </select>
          <button className="ai-new-chat-btn" onClick={newChat}>新对话</button>
        </div>
      </div>

      <div className="ai-messages" ref={messagesScrollRef}>
        {messages.length === 0 ? (
          <div className="ai-empty-state">
            <div className="ai-empty-example" onClick={() => setInputText("时间轴上现在有什么?")}>
              时间轴上现在有什么?
            </div>
            <div className="ai-empty-example" onClick={() => setInputText("把 3 到 8 秒做一张金句卡，文字是...")}>
              把 3 到 8 秒做一张金句卡，文字是...
            </div>
            <div className="ai-empty-example" onClick={() => setInputText("根据我刚导入的视频做字幕")}>
              根据我刚导入的视频做字幕
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={m.id} className={`ai-message ${m.role}`}>
              <div className="ai-message-text">
                {m.attachments && m.attachments.length > 0 && (
                  <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>
                    [附件: {m.attachments.map(a => a.name).join(", ")}]
                  </div>
                )}
                {renderLiteMarkdown(m.text)}
                {m.pending && m.role === "assistant" && i === messages.length - 1 && (
                  <span className="ai-blink-cursor" />
                )}
              </div>

              {m.statuses && m.statuses.length > 0 && (
                <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 4 }}>
                  {m.statuses.map((st, sidx) => (
                    <div key={sidx} className="ai-tool-chip" style={{ opacity: 0.8 }}>
                      信息: {st}
                    </div>
                  ))}
                </div>
              )}
              
              {m.tools && m.tools.length > 0 && (
                <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 4 }}>
                  {m.tools.map((t, tidx) => (
                    <div key={tidx} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div 
                        className={`ai-tool-chip ${t.ok === true ? "ok" : t.ok === false ? "err" : ""}`}
                        onClick={() => toggleTool(m.id, tidx)}
                      >
                        🔧 {t.name} {t.ok === true ? "✓" : t.ok === false ? "✗" : "..."}
                      </div>
                      {t.expanded && t.input ? (
                        <pre style={{ overflowX: "auto", fontSize: 10, background: "var(--bg-canvas)", padding: 6, margin: 0, borderRadius: 4 }}>
                          {JSON.stringify(t.input, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              {m.error && <div className="ai-message-error">{m.error}</div>}
            </div>
          ))
        )}
      </div>

      {toast && <div className="ai-toast">{toast}</div>}
      {error && <div className="ai-toast" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{error}</div>}

      <div className="ai-input-area">
        {attachments.length > 0 && (
          <div className="ai-attachments">
            {attachments.map((a, idx) => (
              <div key={idx} className="ai-attachment-chip">
                {a.kind === "video" ? "🎥" : "📝"} {a.name}
                <span className="ai-attachment-remove" onClick={() => removeAttachment(idx)}>✕</span>
              </div>
            ))}
          </div>
        )}
        
        <div className="ai-input-row">
          <button className="ai-plus-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            +
          </button>
          <input 
            type="file" 
            ref={fileInputRef} 
            accept="video/*,.srt,.json" 
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <textarea
            ref={textareaRef}
            className="ai-textarea"
            value={inputText}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            placeholder={uploading ? "正在导入..." : "给 AI 发消息..."}
            disabled={uploading}
          />
          <button className="ai-send-btn" onClick={streaming ? abort : handleSend}>
            {streaming ? "■" : "↑"}
          </button>
        </div>
      </div>
    </aside>
  );
}
