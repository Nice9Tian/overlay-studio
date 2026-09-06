import { useState, useEffect, useRef, useCallback } from "react";
import type { AiProvider, ChatMessage, ChatAttachment, ProviderInfo, RunEvent, SttInfo } from "./types";
import { parseSseChunks } from "./sse";

export function useAiChat(opts?: { mock?: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sttInfo, setSttInfo] = useState<SttInfo | null>(null);
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [sessionIds, setSessionIds] = useState<Partial<Record<AiProvider, string>>>({});
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const currentRunId = useRef<string | null>(null);

  useEffect(() => {
    if (opts?.mock) {
      setProviders([
        { id: "claude", label: "Claude Code", available: true },
        { id: "agy", label: "Antigravity", available: true }
      ]);
      setProvider("claude");
      return;
    }

    fetch("/api/ai/providers")
      .then((res) => res.json())
      .then((data: any) => {
        let list: ProviderInfo[] = [];
        let stt: SttInfo | null = null;
        if (Array.isArray(data)) {
          list = data;
        } else if (data && typeof data === "object") {
          list = data.providers || [];
          stt = data.stt || null;
        }
        setProviders(list);
        setSttInfo(stt);

        const stored = localStorage.getItem("aiProvider") as AiProvider;
        if (stored && list.some((p) => p.id === stored && p.available)) {
          setProvider(stored);
        } else {
          const firstAvailable = list.find((p) => p.available);
          if (firstAvailable) {
            setProvider(firstAvailable.id);
            localStorage.setItem("aiProvider", firstAvailable.id);
          }
        }
      })
      .catch((e: unknown) => {
        if (e instanceof Error) {
          setError("获取 AI 供应商失败：" + e.message);
        } else {
          setError("获取 AI 供应商失败");
        }
      });
  }, [opts?.mock]);

  useEffect(() => {
    if (!provider) return;
    const history = localStorage.getItem(`aiChat:${provider}`);
    if (history) {
      try {
        const parsed = JSON.parse(history);
        setMessages(parsed.slice(-50));
      } catch {
        setMessages([]);
      }
    } else {
      setMessages([]);
    }
    const sess = localStorage.getItem(`aiSession:${provider}`);
    if (sess) {
      setSessionIds((prev) => ({ ...prev, [provider]: sess }));
    }
  }, [provider]);

  useEffect(() => {
    if (provider && messages.length > 0) {
      const toSave = messages.filter(m => !m.pending);
      localStorage.setItem(`aiChat:${provider}`, JSON.stringify(toSave.slice(-50)));
    }
  }, [messages, provider]);

  const handleProviderChange = (newP: AiProvider) => {
    setProvider(newP);
    localStorage.setItem("aiProvider", newP);
  };

  const newChat = () => {
    if (!provider) return;
    localStorage.removeItem(`aiChat:${provider}`);
    localStorage.removeItem(`aiSession:${provider}`);
    setMessages([]);
    setSessionIds((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
  };

  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (currentRunId.current && !opts?.mock) {
      fetch("/api/ai/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: currentRunId.current }),
      }).catch(() => {});
      currentRunId.current = null;
    }
    setStreaming(false);
  }, [opts?.mock]);

  const send = async (text: string, attachments?: ChatAttachment[]) => {
    if (!provider) return;
    
    abort(); 

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      text,
      attachments,
    };

    const asstMsgId = (Date.now() + 1).toString();
    const asstMsg: ChatMessage = {
      id: asstMsgId,
      role: "assistant",
      text: "",
      tools: [],
      statuses: [],
      pending: true,
    };

    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setStreaming(true);
    setError(null);

    if (opts?.mock) {
      let i = 0;
      const msg = "这是内置假流回复内容。我将调用一个工具看看效果。";
      const timer = setInterval(() => {
        if (i < msg.length) {
          setMessages(prev => prev.map(m => m.id === asstMsgId ? { ...m, text: m.text + msg[i] } : m));
          i++;
        } else {
          clearInterval(timer);
          setMessages(prev => prev.map(m => m.id === asstMsgId ? { ...m, tools: [{ name: "get_editor_state", input: {} }] } : m));
          setTimeout(() => {
            setMessages(prev => prev.map(m => {
              if (m.id !== asstMsgId) return m;
              const tools = [...(m.tools || [])];
              if (tools.length > 0) {
                tools[0].ok = true;
                tools[0].summary = "获取成功";
              }
              return { ...m, tools, pending: false };
            }));
            setStreaming(false);
          }, 1000);
        }
      }, 50);
      return;
    }

    const ac = new AbortController();
    abortControllerRef.current = ac;

    try {
      const sessionId = sessionIds[provider];
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          prompt: text,
          sessionId,
          attachments,
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunks(buffer, chunk);
        buffer = rest;

        for (const ev of events as RunEvent[]) {
          if (ev.type === "run" && ev.runId) {
            currentRunId.current = ev.runId;
          } else if (ev.type === "session" && ev.sessionId) {
            setSessionIds((prev) => ({ ...prev, [provider]: ev.sessionId! }));
            localStorage.setItem(`aiSession:${provider}`, ev.sessionId!);
          } else if (ev.type === "text" && ev.delta) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, text: m.text + ev.delta! } : m
              )
            );
          } else if (ev.type === "tool_call" && ev.name) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const tools = m.tools ? [...m.tools] : [];
                tools.push({ name: ev.name!, input: ev.input, expanded: false });
                return { ...m, tools };
              })
            );
          } else if (ev.type === "tool_result" && ev.name) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const tools = m.tools ? [...m.tools] : [];
                for (let i = tools.length - 1; i >= 0; i--) {
                  if (tools[i].name === ev.name && tools[i].ok === undefined) {
                    tools[i].ok = ev.ok;
                    tools[i].summary = ev.summary;
                    break;
                  }
                }
                return { ...m, tools };
              })
            );
          } else if (ev.type === "status" && ev.text) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const statuses = m.statuses ? [...m.statuses] : [];
                statuses.push(ev.text!);
                return { ...m, statuses };
              })
            );
          } else if (ev.type === "error" && ev.message) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, error: ev.message, pending: false } : m
              )
            );
          } else if (ev.type === "done") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, pending: false } : m
              )
            );
          }
        }
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === asstMsgId ? { ...m, pending: false } : m
        )
      );

    } catch (e: unknown) {
      if (e instanceof Error && e.name !== "AbortError") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstMsgId
              ? { ...m, error: "发生错误: " + e.message, pending: false }
              : m
          )
        );
      }
    } finally {
      if (abortControllerRef.current === ac) {
        abortControllerRef.current = null;
        currentRunId.current = null;
        setStreaming(false);
      }
    }
  };

  return {
    messages,
    providers,
    sttInfo,
    provider,
    setProvider: handleProviderChange,
    sessionIds,
    streaming,
    send,
    abort,
    newChat,
    error,
    setMessages
  };
}
