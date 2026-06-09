import { useEffect, useRef, useState, type RefObject } from "react";

export interface Position {
  x: number;
  y: number;
}

interface UseDraggableArgs {
  initial: Position;
  onCommit: (p: Position) => void; // fired on drag end (for persistence)
}

export function useDraggable({ initial, onCommit }: UseDraggableArgs): {
  position: Position;
  handleRef: RefObject<HTMLDivElement>;
} {
  const [position, setPosition] = useState<Position>(initial);
  const handleRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    const onMouseDown = (e: MouseEvent) => {
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: position.x,
        origY: position.y,
      };
      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      const s = dragState.current;
      if (!s) return;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      const next = {
        x: clamp(s.origX + dx, 0, window.innerWidth - 100),
        y: clamp(s.origY + dy, 0, window.innerHeight - 40),
      };
      setPosition(next);
    };

    const onMouseUp = () => {
      if (dragState.current) {
        dragState.current = null;
        onCommit(position);
      }
    };

    handle.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      handle.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [position, onCommit]);

  return { position, handleRef };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
