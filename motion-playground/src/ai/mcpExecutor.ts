import { EFFECT_GROUPS } from "../effects/registry";
import { parseSrt, type SrtLine } from "../overlay/srt";
import { addPreset, removePreset, listPresets } from "../overlay/presets";
import type { OverlayCard } from "../overlay/types";

// Needed for the contract block to compile
export interface EditorStateForAi {
  curT: number;
  duration: number;
  playing: boolean;
  videoUrl?: string;
  srtName?: string;
  trackCount: number;
  trackNames?: Record<number, string>;
  cards: { id: string; kind: string; name: string; start: number; end: number; track: number; summary: string }[];
  videoAssets: { id: string; name: string; src: string; durationSec?: number }[];
  srtAssets: { id: string; name: string; lines: number; duration: number }[];
  presets?: { id: string; name: string; kind: string; description?: string }[];
}

export interface EditorApi {
  getState(): EditorStateForAi;                    // §3.3 get_editor_state 的结果(不含 presets / assets 也行,executor 自己补)
  getCard(id: string): OverlayCard | undefined;
  addCard(a: { kind: string; start: number; end?: number; track?: number; params?: Record<string, unknown> }): { id: string; start: number; end: number; track: number };   // 冲突就 throw Error("序列 2 在 3.0–8.0 秒已被 card-4(PunchPill)占用")
  updateCard(p: { id: string; start?: number; end?: number; track?: number; params?: Record<string, unknown> }): void;
  removeCard(id: string): void;
  importSrt(name: string, lines: SrtLine[], use: boolean): { id: string };       // 登记 addSrtAsset,use 时 applySrtLines
  registerVideo(a: { url: string; name?: string; setAs?: "reference"|"cam"|"none"; durationSec?: number }): { id: string; url: string };
  seek(t: number): void;
  setPlaying(b: boolean): void;
}
export function connectMcpExecutor(getApi: () => EditorApi, onStatus?: (s: { connected: boolean }) => void): () => void {
  let source: EventSource | null = null;
  let active = true;

  const connect = () => {
    if (!active) return;
    source = new EventSource("/api/mcp/events");

    source.onopen = () => {
      onStatus?.({ connected: true });
    };

    source.onmessage = async (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }

      if (ev.type === "hello") {
        // hello
      } else if (ev.type === "replaced") {
        if (source) source.close();
        source = null;
        onStatus?.({ connected: false });
        window.dispatchEvent(new CustomEvent("ai-chat-error", { detail: "另一个编辑台页面接管了 AI 连接" }));
        active = false;
      } else if (ev.type === "call") {
        const id = ev.id;
        const tool = ev.tool;
        const args = ev.args as any;
        const api = getApi();
        let ok = true;
        let result: unknown;
        let error: string | undefined;

        try {
          if (tool === "get_editor_state") {
            const st = api.getState();
            st.presets = listPresets().map((p: any) => ({
              id: p.id,
              name: p.name,
              kind: p.kind,
              description: p.description
            }));
            result = st;
          } else if (tool === "list_effects") {
            result = EFFECT_GROUPS.flatMap(g => g.effects.map(fx => ({
              kind: fx.id,
              name: fx.name,
              description: fx.description,
              group: g.title,
              tags: fx.tags,
              defaults: fx.defaults,
              controls: fx.controls
            })));
          } else if (tool === "get_card") {
            result = api.getCard(args.id);
          } else if (tool === "add_card") {
            result = api.addCard(args);
          } else if (tool === "update_card") {
            api.updateCard(args);
            result = { ok: true };
          } else if (tool === "remove_card") {
            api.removeCard(args.id);
            result = { ok: true };
          } else if (tool === "import_srt") {
            const lines = parseSrt(args.srt_text);
            const r = api.importSrt(args.name, lines, args.use ?? false);
            const duration = lines.length ? Math.max(...lines.map(l => l.end)) : 0;
            result = { id: r.id, lines: lines.length, duration };
          } else if (tool === "register_video") {
            result = api.registerVideo(args);
          } else if (tool === "seek") {
            api.seek(args.t);
            result = { ok: true };
          } else if (tool === "set_playing") {
            api.setPlaying(args.playing);
            result = { ok: true };
          } else if (tool === "create_preset") {
            const preset = addPreset({
              name: args.name,
              kind: args.kind,
              params: args.params,
              description: args.description,
              source: "ai"
            });
            result = { id: preset.id };
          } else if (tool === "remove_preset") {
            removePreset(args.id);
            result = { ok: true };
          } else {
            throw new Error(`未知工具: ${tool}`);
          }
        } catch (err: unknown) {
          ok = false;
          if (err instanceof Error) {
            error = err.message;
          } else {
            error = String(err);
          }
        }

        fetch("/api/mcp/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, ok, result, error })
        }).catch(() => {});
      }
    };

    source.onerror = () => {
      onStatus?.({ connected: false });
      if (source) source.close();
      if (active) {
        setTimeout(connect, 3000);
      }
    };
  };

  connect();

  return () => {
    active = false;
    if (source) {
      source.close();
      source = null;
    }
  };
}
