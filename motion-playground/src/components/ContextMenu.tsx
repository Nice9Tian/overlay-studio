import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./ContextMenu.css";

/**
 * 通用右键菜单:在 (x, y) 处弹一列菜单项,Esc / 点外面 / 滚动 / 窗口缩放 都关掉。
 * 谁要用,自己管「开没开、开在哪」的 state,这里只负责画和收。
 * 位置会自动避开视口右下边缘(贴着鼠标弹出来又不被裁掉)。
 */

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  /** 危险操作(删除之类)标红 */
  danger?: boolean;
  disabled?: boolean;
  /** 灰字小提示,放在 label 右边(比如「至少保留一条」) */
  hint?: string;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 先按鼠标位置摆,量完尺寸再往回收,别被视口右下角裁掉
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    let left = x;
    let top = y;
    if (left + r.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top + r.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - r.height - pad);
    setPos({ left, top });
  }, [x, y, items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // 用 capture 阶段:菜单外的元素先别收到这次点击(否则一次点击既关菜单又触发别的事)
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      // 菜单自己的右键不要再冒泡出去开第二个菜单
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          className={`ctx-item ${it.danger ? "is-danger" : ""}`}
          disabled={it.disabled}
          onClick={() => {
            if (it.disabled) return;
            onClose();
            it.onClick();
          }}
        >
          <span className="ctx-label">{it.label}</span>
          {it.hint && <span className="ctx-hint">{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}
