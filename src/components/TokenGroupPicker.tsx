import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import type { TokenGroup } from "../types";

export default function TokenGroupPicker({ groups, value, disabled, onChange }: { groups: TokenGroup[]; value: string; disabled?: boolean; onChange: (group: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = groups.find((group) => group.name === value);
  const choose = (group: string) => { setOpen(false); onChange(group); };

  return <>
    <div className="token-group-picker"><div className="field-label"><span>令牌分组</span><small>由 New API 管理</small></div><button className="token-group-trigger" type="button" onClick={() => setOpen(true)} disabled={disabled} aria-haspopup="dialog" aria-expanded={open}><span><strong>{selected?.name || "跟随账户默认分组"}</strong><small>{selected?.description || (selected ? "当前令牌使用的分组" : "使用账户默认令牌分组")}</small></span><ChevronDown size={17} /></button></div>
    {open && <div className="token-group-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section className="token-group-sheet" role="dialog" aria-modal="true" aria-label="选择令牌分组">
      <header><div><span className="eyebrow">TOKEN GROUP</span><strong>选择令牌分组</strong></div><button type="button" onClick={() => setOpen(false)} aria-label="关闭"><X size={18} /></button></header>
      <div className="token-group-options"><button type="button" className={`token-group-option ${!value ? "is-selected" : ""}`} onClick={() => choose("")}><span><strong>跟随账户默认分组</strong><small>由 New API 账户设置决定</small></span><i>{!value && <Check size={13} />}</i></button>{groups.map((group) => <button type="button" key={group.name} className={`token-group-option ${value === group.name ? "is-selected" : ""}`} onClick={() => choose(group.name)}><span><strong>{group.name}</strong><small>{group.description || "令牌可用分组"}</small></span><i>{value === group.name && <Check size={13} />}</i></button>)}</div>
    </section></div>}
  </>;
}
