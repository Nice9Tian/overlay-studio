export const tools = [
  {
    name: "get_editor_state",
    description: "获取当前编辑台状态,包含当前时间、时长、播放状态、素材库和已上时间轴的卡片列表。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "list_effects",
    description: "列出系统支持的所有卡片样式(kind)及其说明、参数定义。建卡前必看。",
    inputSchema: { type: "object", properties: {} },
    side: "browser"
  },
  {
    name: "get_card",
    description: "获取某张卡片的完整参数信息(含所有 params)。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    },
    side: "browser"
  },
  {
    name: "add_card",
    description: "在时间轴上添加一张新卡片。时间单位为秒。成功返回 {id, start, end, track}。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        start: { type: "number" },
        end: { type: "number" },
        track: { type: "number" },
        params: { type: "object" }
      },
      required: ["kind", "start"]
    },
    side: "browser"
  },
  {
    name: "update_card",
    description: "更新时间轴上的某张卡片,params 为局部更新。时间单位为秒。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        start: { type: "number" },
        end: { type: "number" },
        track: { type: "number" },
        params: { type: "object" }
      },
      required: ["id"]
    },
    side: "browser"
  },
  {
    name: "remove_card",
    description: "删除时间轴上的某张卡片。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    },
    side: "browser"
  },
  {
    name: "import_srt",
    description: "导入一段 SRT 格式的文本作为字幕素材。use=true 则同时用作当前视频的字幕稿。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        srt_text: { type: "string" },
        use: { type: "boolean" }
      },
      required: ["name", "srt_text"]
    },
    side: "browser"
  },
  {
    name: "import_video",
    description: "内部方法：将视频导入素材库(会自动复制到 public/_media/)并登记。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        url: { type: "string" },
        name: { type: "string" },
        set_as: { type: "string", enum: ["reference", "cam", "none"] }
      }
    },
    side: "hybrid"
  },
  {
    name: "seek",
    description: "跳转到时间轴的指定秒数。",
    inputSchema: {
      type: "object",
      properties: { t: { type: "number" } },
      required: ["t"]
    },
    side: "browser"
  },
  {
    name: "set_playing",
    description: "设置播放或暂停状态。",
    inputSchema: {
      type: "object",
      properties: { playing: { type: "boolean" } },
      required: ["playing"]
    },
    side: "browser"
  },
  {
    name: "create_preset",
    description: "创建一个自定义卡的预设样式,以便用户一键添加到时间轴。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        kind: { type: "string" },
        params: { type: "object" },
        description: { type: "string" }
      },
      required: ["name", "kind", "params"]
    },
    side: "browser"
  },
  {
    name: "remove_preset",
    description: "删除预设。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    },
    side: "browser"
  },
  {
    name: "transcribe_video",
    description: "提取视频/音频文件的语音并识别为 SRT 文本。耗时较长,最多可等 30 分钟。输入本地绝对路径 path 或 站内 url。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        url: { type: "string" },
        language: { type: "string" }
      }
    },
    side: "server"
  },
  {
    name: "probe_media",
    description: "获取音视频文件的时长和体积信息。输入本地绝对路径 path 或 站内 url。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        url: { type: "string" }
      }
    },
    side: "server"
  },
  {
    name: "get_card_authoring_guide",
    description: "获取创建自定义卡片(custom-card)的编写指南(Markdown 格式)。",
    inputSchema: { type: "object", properties: {} },
    side: "server"
  }
];
