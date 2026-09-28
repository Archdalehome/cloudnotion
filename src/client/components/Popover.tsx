import { useEffect, useRef, useState } from 'react';

interface PopoverProps {
  /** trigger content */
  label: React.ReactNode;
  title?: string;
  wide?: boolean;
  disabled?: boolean;
  /** render prop receiving a close() helper */
  children: (close: () => void) => React.ReactNode;
}

/** Button + anchored panel that closes on outside click / Escape. */
export function Popover({ label, title, wide, disabled, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
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
        type="button"
        className={`btn ghost small${open ? ' active' : ''}`}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
      >
        {label}
      </button>
      {open ? <div className={`popover${wide ? ' wide' : ''}`}>{children(() => setOpen(false))}</div> : null}
    </div>
  );
}
