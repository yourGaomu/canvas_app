import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, X } from "lucide-react";

export type PickerOption = { value: string; label: string };

type Props = {
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

export default function OptionPicker({ label, value, options, onChange, placeholder = "请选择", disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return <div className="option-picker">
    <button type="button" className="option-picker-trigger" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}>
      <span>{selected?.label || placeholder}</span><ChevronDown size={15} />
    </button>
    {open && createPortal(<div className="option-picker-overlay" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="option-picker-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <header><div><span className="eyebrow">SELECT OPTION</span><strong>{label}</strong></div><button type="button" aria-label="关闭选择列表" onClick={() => setOpen(false)}><X size={18} /></button></header>
        <div className="option-picker-list" role="listbox" aria-label={label}>
          {options.map((option) => <button key={option.value} type="button" className={option.value === value ? "is-selected" : ""} role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }}>
            <span>{option.label}</span>{option.value === value && <Check size={17} />}
          </button>)}
          {!options.length && <p className="option-picker-empty">暂无可选项</p>}
        </div>
      </section>
    </div>, document.body)}
  </div>;
}
