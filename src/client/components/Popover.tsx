import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  /** trigger content */
  label: React.ReactNode;
  title?: string;
  wide?: boolean;
  disabled?: boolean;
  /** trigger style (defaults to a ghost button) */
  variant?: 'ghost' | 'primary';
  /** which edge of the trigger the panel is aligned to (default: right) */
  align?: 'left' | 'right';
  /** render prop receiving a close() helper */
  children: (close: () => void) => React.ReactNode;
}

interface PanelPosition {
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
}

const PANEL_WIDTH = { normal: 320, wide: 420 };
const GAP = 6;
const MARGIN = 8;
/** keep at least this much room before flipping the panel above the trigger */
const MIN_HEIGHT = 220;

/**
 * Button + panel that closes on outside click / Escape.
 *
 * The panel is rendered through a portal with `position: fixed`, so it is never
 * clipped by scrollable / `overflow: hidden` ancestors (视图栏、表格表头等),
 * and it flips above the trigger when there is not enough room below.
 */
export function Popover({
  label,
  title,
  wide,
  disabled,
  variant = 'ghost',
  align = 'right',
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  /** Anchor the panel to the trigger, clamped to the viewport. */
  const place = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = wide ? PANEL_WIDTH.wide : PANEL_WIDTH.normal;
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const left = Math.min(Math.max(MARGIN, align === 'left' ? rect.left : rect.right - width), maxLeft);
    const below = window.innerHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    if (below < MIN_HEIGHT && above > below) {
      setPosition({
        bottom: Math.max(MARGIN, window.innerHeight - rect.top + GAP),
        left,
        maxHeight: Math.max(MIN_HEIGHT, above),
      });
    } else {
      setPosition({ top: rect.bottom + GAP, left, maxHeight: Math.max(MIN_HEIGHT, below) });
    }
  }, [align, wide]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (host.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="popover-host" ref={host}>
      <button
        ref={trigger}
        type="button"
        className={`btn ${variant === 'primary' ? 'primary' : 'ghost'} small${open ? ' active' : ''}`}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
      >
        {label}
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              className={`popover${wide ? ' wide' : ''}`}
              style={{
                top: position?.top ?? 'auto',
                bottom: position?.bottom ?? 'auto',
                left: position?.left ?? 0,
                right: 'auto',
                maxHeight: position ? position.maxHeight : undefined,
                visibility: position ? 'visible' : 'hidden',
              }}
            >
              {children(() => setOpen(false))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

