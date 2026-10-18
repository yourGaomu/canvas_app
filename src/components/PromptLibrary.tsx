import { useEffect, useMemo, useState } from "react";
import { BookOpen, CircleAlert, LoaderCircle, Search, X } from "lucide-react";
import { fetchPromptLibrary, type MobilePrompt } from "../api/prompts";

export default function PromptLibrary({ onSelect, onClose }: { onSelect: (prompt: string) => void; onClose: () => void }) {
  const [items, setItems] = useState<MobilePrompt[]>([]);
  const [category, setCategory] = useState("全部");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const categories = useMemo(() => ["全部", ...new Set(items.map((item) => item.category))], [items]);
  const visible = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return items.filter((item) => (category === "全部" || item.category === category) && (!keyword || `${item.title} ${item.prompt} ${item.description} ${item.tags.join(" ")}`.toLowerCase().includes(keyword))).slice(0, 100);
  }, [category, items, search]);

  useEffect(() => {
    let cancelled = false;
    void fetchPromptLibrary().then((prompts) => { if (!cancelled) setItems(prompts); }).catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : "提示词库加载失败"); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return <div className="prompt-library-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="prompt-library-sheet" role="dialog" aria-modal="true" aria-label="提示词库">
      <header className="prompt-library-heading"><div><span className="eyebrow">PROMPT LIBRARY / {items.length}</span><strong><BookOpen size={18} />提示词库</strong></div><button onClick={onClose} aria-label="关闭提示词库"><X size={19} /></button></header>
      <label className="prompt-library-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、内容或标签" /></label>
      <div className="prompt-library-categories">{categories.map((item) => <button key={item} className={category === item ? "is-active" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div>
      {loading ? <div className="prompt-library-state"><LoaderCircle className="spin" size={19} />正在获取提示词…</div> : error ? <div className="prompt-library-state prompt-library-error"><CircleAlert size={17} />{error}<button onClick={() => { setLoading(true); setError(""); void fetchPromptLibrary().then(setItems).catch((loadError) => setError(loadError instanceof Error ? loadError.message : "提示词库加载失败")).finally(() => setLoading(false)); }}>重试</button></div> : <div className="prompt-library-list">{visible.map((item) => <article className="prompt-library-item" key={`${item.category}:${item.id}`}>
        {item.coverUrl ? <img src={item.coverUrl} alt="" loading="lazy" /> : <div className="prompt-library-cover"><BookOpen size={18} /></div>}
        <div className="prompt-library-copy"><span>{item.category}</span><strong>{item.title}</strong><p>{item.description || item.prompt}</p><button onClick={() => { onSelect(item.prompt); onClose(); }}>使用提示词</button></div>
      </article>)}{!visible.length && <div className="prompt-library-state">没有匹配的提示词</div>}</div>}
    </section>
  </div>;
}
