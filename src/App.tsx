import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Download,
  Image as ImageIcon,
  Images,
  KeyRound,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquareText,
  PanelBottom,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import {
  chooseDefaultTokenGroup,
  fetchCurrentUser,
  fetchPublicStatus,
  fetchUserGroups,
  loginUser,
  logoutUser,
  refreshSession,
  registerUser,
  verifyTwoFactor,
  type LoginResult,
} from "./api/auth";
import { createVideo, editImage, generateImage, getVideo, chatCompletion } from "./api/generation";
import { listModels } from "./api/models";
import { ensureCanvasToken } from "./api/tokens";
import { ApiError } from "./api/client";
import { logger } from "./lib/logger";
import { exportAsset } from "./lib/export-asset";
import { clearSession, readAssets, readSession, writeAssets, writeSession } from "./storage";
import CanvasView from "./canvas/CanvasView";
import PromptLibrary from "./components/PromptLibrary";
import TokenGroupPicker from "./components/TokenGroupPicker";
import type { AuthSession, GeneratedAsset, Model, TokenGroup, User, VideoTask } from "./types";

type Tab = "create" | "canvas" | "assets" | "account";
type CreateMode = "image" | "edit" | "video" | "chat";

const modeMeta: Record<CreateMode, { label: string; icon: typeof ImageIcon }> = {
  image: { label: "生图", icon: ImageIcon },
  edit: { label: "改图", icon: WandSparkles },
  video: { label: "视频", icon: Video },
  chat: { label: "对话", icon: MessageSquareText },
};

function formatQuota(value: number) {
  const amount = Math.max(0, value) / 1000000;
  if (amount >= 1000) return `¥${(amount / 1000).toFixed(1)}k`;
  return `¥${amount.toFixed(2)}`;
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "请求失败，请稍后再试";
}

async function handleAssetExport(asset: GeneratedAsset, apiToken = "") {
  try {
    await exportAsset(asset, apiToken);
  } catch (error) {
    window.alert(getErrorMessage(error));
  }
}

async function resolveTokenGroup(accessToken: string, userGroup: string, currentGroup = "") {
  const [groupsResult, statusResult] = await Promise.allSettled([fetchUserGroups(accessToken), fetchPublicStatus()]);
  const groups = groupsResult.status === "fulfilled" ? groupsResult.value : [];
  if (groups.length) {
    const group = chooseDefaultTokenGroup(groups, userGroup, statusResult.status === "fulfilled" && statusResult.value.defaultUseAutoGroup);
    logger.info("token:group:selected", { group, userGroup, availableGroups: groups.map((item) => item.name), autoDefault: statusResult.status === "fulfilled" && statusResult.value.defaultUseAutoGroup });
    return group;
  }
  logger.warn("token:group:fallback", { currentGroup, groupsRequestSucceeded: groupsResult.status === "fulfilled", statusRequestSucceeded: statusResult.status === "fulfilled" });
  return currentGroup;
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function Button({
  children,
  className = "",
  type = "button",
  disabled,
  onClick,
  variant = "ghost",
}: {
  children: ReactNode;
  className?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  variant?: "ghost" | "primary" | "dark";
}) {
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`button button-${variant} ${className}`}>
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <span className="brand-mark">✦</span>
      <span className="brand-copy">
        <strong>Infinite Canvas</strong>
        <small>移动创作工作台</small>
      </span>
    </div>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [flowToken, setFlowToken] = useState("");
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const finishLogin = async (result: LoginResult) => {
    if (result.requiresTwoFactor) {
      setFlowToken(result.flowToken);
      setNeedsTwoFactor(true);
      return;
    }
    const user = await fetchCurrentUser(result.session.accessToken).catch(() => result.session.user);
    const group = await resolveTokenGroup(result.session.accessToken, user.group);
    const token = await ensureCanvasToken(result.session.accessToken, group);
    const session: AuthSession = { ...result.session, user, apiToken: token.key, apiTokenId: token.token.id, apiTokenGroup: token.token.group };
    await writeSession(session);
    onAuthenticated(session);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!username.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
    setBusy(true);
    try {
      if (needsTwoFactor) {
        await finishLogin(await verifyTwoFactor(flowToken, code.trim()));
      } else if (mode === "register") {
        await registerUser({ username: username.trim(), password, email: email.trim() });
        setMode("login");
        setError("注册成功，请登录");
      } else {
        await finishLogin(await loginUser(username.trim(), password));
      }
    } catch (requestError) {
      logger.error("auth:login:failed", { error: getErrorMessage(requestError) });
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-art">
        <div className="art-grid" />
        <div className="art-stamp">CANVAS / 01</div>
        <div className="art-copy">
          <p className="eyebrow">MAKE SPACE FOR IDEAS</p>
          <h1>把灵感变成<br /><em>可继续的画面。</em></h1>
          <p>一处工作台，串起提示词、图片、视频和每一次迭代。</p>
        </div>
        <div className="art-orbit orbit-one" />
        <div className="art-orbit orbit-two" />
        <div className="art-note"><Sparkles size={14} /> local-first / api-connected</div>
      </section>
      <section className="auth-panel">
        <Brand />
        <div className="auth-intro">
          <p className="eyebrow">YOUR PRIVATE STUDIO</p>
          <h2>{needsTwoFactor ? "验证登录" : mode === "login" ? "欢迎回来" : "创建账户"}</h2>
          <p>{needsTwoFactor ? "输入 New API 发送的二次验证码，继续进入工作台。" : "使用 mikasa.icu 账户登录，额度与模型由 New API 统一管理。"}</p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          {needsTwoFactor ? (
            <Field label="二次验证码">
              <input autoFocus value={code} onChange={(event) => setCode(event.target.value)} placeholder="输入验证码" inputMode="numeric" />
            </Field>
          ) : (
            <>
              <Field label="用户名">
                <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="你的用户名" />
              </Field>
              {mode === "register" && (
                <Field label="邮箱" hint="可选">
                  <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
                </Field>
              )}
              <Field label="密码">
                <input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" />
              </Field>
            </>
          )}
          {error && <div className={`notice ${error.includes("成功") ? "notice-success" : "notice-error"}`}><CircleAlert size={15} />{error}</div>}
          <Button type="submit" variant="primary" className="auth-submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={18} /> : needsTwoFactor ? <Check size={18} /> : mode === "login" ? <ArrowUpRight size={18} /> : <Plus size={18} />}
            {busy ? "处理中" : needsTwoFactor ? "完成验证" : mode === "login" ? "进入工作台" : "注册并继续"}
          </Button>
        </form>
        <div className="auth-switch">
          {needsTwoFactor ? <button onClick={() => { setNeedsTwoFactor(false); setFlowToken(""); }}>返回登录</button> : <button onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "还没有账户？注册" : "已有账户？登录"}</button>}
        </div>
        <p className="auth-footnote"><KeyRound size={13} /> 登录后仅在本机安全存储你的用户 Token</p>
      </section>
    </main>
  );
}

function Header({ user, activeTab, onMenu }: { user: User; activeTab: Tab; onMenu: () => void }) {
  return (
    <header className="app-header">
      <Button onClick={onMenu} className="menu-button"><Menu size={19} /></Button>
      <div className="header-context">
        <span className="header-kicker">{activeTab === "create" ? "WORKSPACE" : activeTab === "canvas" ? "INFINITE SPACE" : activeTab === "assets" ? "LIBRARY" : "ACCOUNT"}</span>
        <strong>{activeTab === "create" ? "新建创作" : activeTab === "canvas" ? "我的画布" : activeTab === "assets" ? "我的素材" : user.displayName || user.username}</strong>
      </div>
      <div className="header-actions">
        <span className="quota-chip"><span className="status-dot" />{formatQuota(user.quota - user.usedQuota)}</span>
        <div className="avatar">{(user.displayName || user.username || "U").slice(0, 1).toUpperCase()}</div>
      </div>
    </header>
  );
}

function SideRail({ activeTab, onChange, open }: { activeTab: Tab; onChange: (tab: Tab) => void; open: boolean }) {
  const items: Array<{ id: Tab; label: string; icon: typeof ImageIcon }> = [
    { id: "create", label: "创作", icon: Sparkles },
    { id: "canvas", label: "画布", icon: PanelBottom },
    { id: "assets", label: "素材", icon: Images },
    { id: "account", label: "账户", icon: UserRound },
  ];
  return <aside className={`side-rail ${open ? "is-open" : ""}`}>
    <Brand compact />
    <nav>{items.map(({ id, label, icon: Icon }) => <button className={activeTab === id ? "is-active" : ""} key={id} onClick={() => onChange(id)}><Icon size={18} /><span>{label}</span>{activeTab === id && <i />}</button>)}</nav>
    <div className="rail-bottom"><div className="rail-status"><span className="status-dot" />API 在线</div><small>mikasa.icu</small></div>
  </aside>;
}

function BottomNav({ activeTab, onChange }: { activeTab: Tab; onChange: (tab: Tab) => void }) {
  const items: Array<{ id: Tab; label: string; icon: typeof ImageIcon }> = [
    { id: "create", label: "创作", icon: Sparkles },
    { id: "canvas", label: "画布", icon: PanelBottom },
    { id: "assets", label: "素材", icon: Images },
    { id: "account", label: "账户", icon: UserRound },
  ];
  return <nav className="bottom-nav">{items.map(({ id, label, icon: Icon }) => <button className={activeTab === id ? "is-active" : ""} key={id} onClick={() => onChange(id)}><Icon size={19} /><span>{label}</span></button>)}</nav>;
}

function CreateView({ session, models, assets, onAssets, onRefreshModels }: { session: AuthSession; models: Model[]; assets: GeneratedAsset[]; onAssets: (assets: GeneratedAsset[]) => void; onRefreshModels: () => Promise<void> }) {
  const [mode, setMode] = useState<CreateMode>("image");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("1:1");
  const [quality, setQuality] = useState("auto");
  const [count, setCount] = useState(1);
  const [references, setReferences] = useState<Array<{ url: string; name: string }>>([]);
  const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [chatAnswer, setChatAnswer] = useState("");
  const [videoTask, setVideoTask] = useState<VideoTask | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const imageModels = useMemo(() => models.filter((item) => item.capability === "image"), [models]);
  const videoModels = useMemo(() => models.filter((item) => item.capability === "video"), [models]);
  const textModels = useMemo(() => models.filter((item) => item.capability === "text"), [models]);
  const availableModels = mode === "video" ? videoModels : mode === "chat" ? textModels : imageModels;

  useEffect(() => {
    if (!availableModels.some((item) => item.id === model)) setModel(availableModels[0]?.id || "");
  }, [availableModels, model]);

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const selected = await Promise.all(Array.from(files).map(async (file) => ({ url: await readFileAsDataUrl(file), name: file.name })));
      setReferences((current) => mode === "video" ? selected.slice(0, 1) : [...current, ...selected]);
      setError("");
    } catch (readError) {
      setError(getErrorMessage(readError));
    }
  };

  const saveNewAssets = async (newAssets: GeneratedAsset[]) => {
    const next = [...newAssets, ...assets].slice(0, 60);
    onAssets(next);
    await writeAssets(next);
  };

  const pollVideo = async (taskId: string) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1200 : 2500));
      const next = await getVideo(session.apiToken, taskId);
      setVideoTask(next);
      if (next.status === "completed" || next.url) {
        const url = next.url || `${"https://mikasa.icu"}/v1/videos/${encodeURIComponent(taskId)}/content`;
        await saveNewAssets([{ id: `video-${taskId}`, kind: "video", url, model, prompt, createdAt: Date.now() }]);
        return;
      }
      if (["failed", "cancelled", "error"].includes(String(next.status).toLowerCase())) throw new Error(next.error || "视频生成失败");
    }
    throw new Error("视频任务超时，请稍后在素材中查看");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim()) {
      setError("先写一句提示词，再开始生成");
      return;
    }
    if (!model) {
      setError("当前没有可用模型，请刷新模型列表");
      return;
    }
    setBusy(true);
    setError("");
    setStatus(mode === "video" ? "正在创建视频任务…" : "正在连接模型…");
    setChatAnswer("");
    setVideoTask(null);
    try {
      if (mode === "image") {
        setStatus("正在绘制画面…");
        await saveNewAssets(await generateImage(session.apiToken, model, prompt.trim(), { size, quality, count }));
        setStatus("已保存到素材");
      } else if (mode === "edit") {
        if (!references.length) throw new Error("改图需要先上传参考图");
        setStatus("正在重组画面…");
        await saveNewAssets(await editImage(session.apiToken, model, prompt.trim(), references.map((item) => item.url), undefined, count));
        setStatus("编辑结果已保存到素材");
      } else if (mode === "video") {
        const task = await createVideo(session.apiToken, model, prompt.trim(), references[0]?.url);
        setVideoTask(task);
        setStatus("任务已创建，正在等待上游完成…");
        await pollVideo(task.id);
        setStatus("视频已保存到素材");
      } else {
        setStatus("正在思考…");
        const response = await chatCompletion(session.apiToken, model, [{ role: "user", content: prompt.trim() }]);
        const text = response.choices?.[0]?.message?.content || "模型没有返回文字";
        setChatAnswer(text);
        await saveNewAssets([{ id: `text-${Date.now()}`, kind: "text", url: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`, model, prompt, createdAt: Date.now() }]);
        setStatus("回答已保存");
      }
    } catch (requestError) {
      logger.error("generation:failed", { mode, model, error: getErrorMessage(requestError) });
      setError(getErrorMessage(requestError));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const modeDescription = mode === "image" ? "从一句话开始，生成一组可继续编辑的画面。" : mode === "edit" ? "上传参考图，用自然语言改变局部或整体。" : mode === "video" ? "把提示词或参考图交给视频模型，等待任务完成。" : "把问题交给模型，回答会存进你的素材库。";
  return <section className="page create-page">
    <div className="page-heading"><div><p className="eyebrow">CREATE / {String(mode).toUpperCase()}</p><h1>今天，做点新的。</h1><p>{modeDescription}</p></div><Button className="refresh-button" onClick={() => void onRefreshModels()}><RefreshCw size={16} />刷新模型</Button></div>
    <div className="mode-tabs">{(Object.keys(modeMeta) as CreateMode[]).map((item) => { const Icon = modeMeta[item].icon; return <button key={item} className={mode === item ? "is-active" : ""} onClick={() => { setMode(item); setError(""); }}><Icon size={17} />{modeMeta[item].label}</button>; })}</div>
    <form className="create-layout" onSubmit={submit}>
      <div className="prompt-panel panel">
        <div className="panel-topline"><span className="panel-index">01</span><span>描述你的想法</span><span className="panel-spacer" /><button type="button" className="prompt-library-trigger" onClick={() => setPromptLibraryOpen(true)}><BookOpen size={14} />提示词库</button><span className="live-label"><span className="status-dot" />LIVE</span></div>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode === "chat" ? "问一个问题，或者描述你需要的方案…" : mode === "video" ? "例如：雨夜的东京街头，镜头缓慢向前推进…" : "例如：一间有天窗的工作室，清晨的光落在木桌上…"} rows={7} />
        <div className="prompt-footer"><span>{prompt.length} / 2000</span><Button className="clear-button" onClick={() => setPrompt("")}><Trash2 size={14} />清空</Button></div>
      </div>
      <div className="settings-panel panel">
        <div className="panel-topline"><span className="panel-index">02</span><span>生成设置</span></div>
        <Field label="模型">
          <div className="select-wrap"><select value={model} onChange={(event) => setModel(event.target.value)}><option value="">暂无可用模型</option>{availableModels.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select><ChevronDown size={15} /></div>
        </Field>
        {(mode === "image" || mode === "edit") && <div className="setting-grid"><Field label="画幅"><div className="select-wrap"><select value={size} onChange={(event) => setSize(event.target.value)}><option value="1:1">1:1 方形</option><option value="16:9">16:9 横向</option><option value="9:16">9:16 竖向</option><option value="4:3">4:3 标准</option></select><ChevronDown size={15} /></div></Field><Field label="质量"><div className="select-wrap"><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select><ChevronDown size={15} /></div></Field></div>}
        {(mode === "image" || mode === "edit") && <Field label="张数" hint={`${count} 张`}><input type="range" min="1" max="4" value={count} onChange={(event) => setCount(Number(event.target.value))} /></Field>}
        {(mode === "edit" || mode === "video") && <div className="reference-block"><div className="field-label">参考图片{mode === "edit" ? " · 可多选" : ""}</div><button type="button" className="upload-zone" onClick={() => fileInput.current?.click()}><Upload size={18} /><span>{references.length ? "继续添加图片" : "点击选择图片"}</span><small>{references.length ? `已选 ${references.length} 张` : "PNG / JPG / WebP"}</small></button>{Boolean(references.length) && <div className="reference-thumbnails">{references.map((item, index) => <div key={`${item.name}-${index}`}><img src={item.url} alt={item.name} /><button type="button" onClick={() => setReferences((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除${item.name}`}><X size={13} /></button></div>)}</div>}<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple={mode === "edit"} hidden onChange={(event) => { void pickFiles(event.target.files); event.currentTarget.value = ""; }} /></div>}
        {error && <div className="notice notice-error"><CircleAlert size={15} />{error}</div>}
        <Button type="submit" variant="primary" className="generate-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}{busy ? status || "处理中" : mode === "chat" ? "发送给模型" : mode === "video" ? "开始生成视频" : mode === "edit" ? "开始编辑" : "生成图片"}<ArrowUpRight size={17} /></Button>
        {status && !error && <p className="action-status"><span className={busy ? "pulse-dot" : "status-dot"} />{status}</p>}
      </div>
    </form>
    {videoTask && <div className="task-strip"><div><span className="eyebrow">VIDEO TASK</span><strong>{videoTask.id}</strong></div><span className={`task-status ${videoTask.status === "completed" ? "done" : ""}`}><span className="status-dot" />{videoTask.status || "processing"}</span></div>}
    {chatAnswer && <div className="answer-panel panel"><div className="panel-topline"><span className="panel-index">OUT</span><span>模型回答</span><Button onClick={() => void navigator.clipboard?.writeText(chatAnswer)}><Copy size={14} />复制</Button></div><p>{chatAnswer}</p></div>}
    <div className="recent-strip"><div className="section-title"><div><span className="eyebrow">RECENT OUTPUTS</span><h2>最近生成</h2></div><span>{assets.length} 项</span></div><div className="recent-grid">{assets.slice(0, 4).map((asset) => <AssetThumb asset={asset} key={asset.id} onExport={(item) => void handleAssetExport(item, session.apiToken)} />)}{!assets.length && <div className="empty-inline"><Sparkles size={17} />你的第一张作品会出现在这里</div>}</div></div>
    {promptLibraryOpen && <PromptLibrary onClose={() => setPromptLibraryOpen(false)} onSelect={(value) => setPrompt((current) => current.trim() ? `${current.trim()}\n\n${value}` : value)} />}
  </section>;
}

function AssetThumb({ asset, onDelete, onExport }: { asset: GeneratedAsset; onDelete?: () => void; onExport?: (asset: GeneratedAsset) => void }) {
  return <article className={`asset-thumb asset-${asset.kind}`}>
    {asset.kind === "image" ? <img src={asset.url} alt={asset.prompt} /> : asset.kind === "video" ? <video src={asset.url} muted playsInline preload="metadata" /> : <div className="text-thumb"><MessageSquareText size={18} /><p>{asset.prompt}</p></div>}
    <div className="asset-thumb-meta"><span>{asset.model}</span><div>{onExport && <button className="asset-export-button" onClick={() => onExport(asset)} aria-label="导出素材" title="导出素材"><Download size={14} /></button>}{onDelete && <button onClick={onDelete} aria-label="删除素材"><Trash2 size={14} /></button>}</div></div>
  </article>;
}

function AssetsView({ assets, apiToken, onDelete }: { assets: GeneratedAsset[]; apiToken: string; onDelete: (id: string) => void }) {
  const [filter, setFilter] = useState<"all" | GeneratedAsset["kind"]>("all");
  const filtered = assets.filter((asset) => filter === "all" || asset.kind === filter);
  return <section className="page assets-page"><div className="page-heading"><div><p className="eyebrow">LIBRARY / {assets.length} ITEMS</p><h1>你的素材。</h1><p>所有生成结果都只保存在这台设备上。</p></div><Button variant="dark"><Upload size={16} />导入素材</Button></div><div className="filter-tabs">{(["all", "image", "video", "text"] as const).map((value) => <button key={value} className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>{value === "all" ? "全部" : value === "image" ? "图片" : value === "video" ? "视频" : "对话"}<span>{value === "all" ? assets.length : assets.filter((asset) => asset.kind === value).length}</span></button>)}</div><div className="asset-grid">{filtered.map((asset) => <AssetThumb key={asset.id} asset={asset} onExport={(item) => void handleAssetExport(item, apiToken)} onDelete={() => onDelete(asset.id)} />)}{!filtered.length && <div className="empty-state"><Images size={31} /><strong>这里还没有素材</strong><span>回到创作页，做出第一件作品。</span></div>}</div></section>;
}

function AccountView({ session, onSession, onTokenChanged, onLogout }: { session: AuthSession; onSession: (session: AuthSession) => void; onTokenChanged: (session: AuthSession) => Promise<void>; onLogout: () => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  const [groups, setGroups] = useState<TokenGroup[]>([]);
  const [groupBusy, setGroupBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [groupError, setGroupError] = useState("");

  const loadGroups = useCallback(async () => {
    setGroups(await fetchUserGroups(session.accessToken));
  }, [session.accessToken]);

  useEffect(() => {
    void loadGroups().catch((error) => setGroupError(getErrorMessage(error)));
  }, [loadGroups]);

  const changeGroup = async (group: string) => {
    if (group === (session.apiTokenGroup || "")) return;
    setGroupBusy(true);
    setGroupError("");
    setMessage("正在切换令牌分组…");
    try {
      const token = await ensureCanvasToken(session.accessToken, group);
      const next = { ...session, apiToken: token.key, apiTokenId: token.token.id, apiTokenGroup: token.token.group };
      await writeSession(next);
      await onTokenChanged(next);
      setMessage(`已切换到 ${token.token.group || "账户默认分组"}`);
    } catch (error) {
      setGroupError(getErrorMessage(error));
      setMessage("");
    } finally {
      setGroupBusy(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const user = await fetchCurrentUser(session.accessToken);
      const next = { ...session, user };
      await writeSession(next);
      onSession(next);
      await loadGroups();
      setMessage("账户信息已更新");
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  };
  return <section className="page account-page"><div className="page-heading"><div><p className="eyebrow">ACCOUNT / NEW API</p><h1>你的工作台账户。</h1><p>额度、模型和请求都由 mikasa.icu 统一管理。</p></div><Button onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} size={16} />刷新</Button></div><div className="account-grid"><div className="account-card profile-card"><div className="profile-top"><div className="profile-avatar">{(session.user.displayName || session.user.username || "U").slice(0, 1).toUpperCase()}</div><div><span className="eyebrow">SIGNED IN AS</span><h2>{session.user.displayName || session.user.username}</h2><p>@{session.user.username}</p></div></div><div className="profile-line"><span>邮箱</span><strong>{session.user.email || "未填写"}</strong></div><div className="profile-line"><span>API 状态</span><strong className="online"><span className="status-dot" />已连接</strong></div></div><div className="account-card quota-card"><span className="eyebrow">REMAINING QUOTA</span><strong>{formatQuota(session.user.quota - session.user.usedQuota)}</strong><div className="quota-track"><i style={{ width: `${Math.min(100, Math.max(3, ((session.user.quota - session.user.usedQuota) / Math.max(1, session.user.quota)) * 100))}%` }} /></div><p>已使用 {formatQuota(session.user.usedQuota)} / 总额度 {formatQuota(session.user.quota)}</p></div><div className="account-card token-card"><div className="card-heading"><div><span className="eyebrow">PRIVATE TOKEN</span><h3>Infinite Canvas</h3></div><KeyRound size={19} /></div><p>你的生成请求使用 New API 用户 Token。完整 Key 不会在界面展示。</p><TokenGroupPicker groups={groups} value={session.apiTokenGroup || ""} disabled={groupBusy} onChange={(group) => void changeGroup(group)} /><div className="token-mask">•••• •••• •••• {String(session.apiToken).slice(-4)}</div><div className="token-foot"><span><Check size={14} />安全存储</span><span>请求 {session.user.requestCount} 次</span></div></div></div>{groupError && <div className="notice notice-error"><CircleAlert size={15} />{groupError}</div>}{message && <div className="notice notice-success"><Check size={15} />{message}</div>}<div className="account-actions"><Button><Settings2 size={16} />偏好设置</Button><Button onClick={() => void onLogout()} className="logout-button"><LogOut size={16} />退出登录</Button></div></section>;
}

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("create");
  const [railOpen, setRailOpen] = useState(false);
  const [booting, setBooting] = useState(true);
  const [modelError, setModelError] = useState("");
  const pageScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
  }, [activeTab]);

  const loadModels = useCallback(async (apiToken: string) => {
    try {
      setModels(await listModels(apiToken));
      setModelError("");
    } catch (error) {
      logger.error("models:list:failed", { error: getErrorMessage(error) });
      setModelError(getErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    logger.info("app:startup");
    void (async () => {
      const [storedSession, storedAssets] = await Promise.all([readSession(), readAssets()]);
      setAssets(storedAssets);
      if (storedSession) {
        try {
          let next = storedSession;
          try {
            next = { ...storedSession, user: await fetchCurrentUser(storedSession.accessToken) };
          } catch {
            const refreshed = await refreshSession(storedSession.accessToken, storedSession.sessionId);
            next = { ...storedSession, ...refreshed, apiToken: storedSession.apiToken, apiTokenId: storedSession.apiTokenId, apiTokenGroup: storedSession.apiTokenGroup };
            next = { ...next, user: await fetchCurrentUser(next.accessToken).catch(() => next.user) };
          }
          const group = await resolveTokenGroup(next.accessToken, next.user.group || "", next.apiTokenGroup || "");
          const token = await ensureCanvasToken(next.accessToken, group);
          next = { ...next, apiToken: token.key, apiTokenId: token.token.id, apiTokenGroup: token.token.group };
          setSession(next);
          await writeSession(next);
          await loadModels(next.apiToken);
        } catch (error) {
          logger.error("session:restore:failed", { error: getErrorMessage(error) });
          await clearSession();
        }
      }
      setBooting(false);
    })();
  }, [loadModels]);

  const authenticate = async (next: AuthSession) => {
    setSession(next);
    await loadModels(next.apiToken);
  };

  const logout = async () => {
    if (session) await logoutUser(session.accessToken, session.sessionId).catch(() => undefined);
    await clearSession();
    setSession(null);
    setModels([]);
  };

  const updateAssets = (next: GeneratedAsset[]) => setAssets(next);
  const deleteAsset = async (id: string) => {
    const next = assets.filter((asset) => asset.id !== id);
    setAssets(next);
    await writeAssets(next);
  };

  if (booting) return <div className="boot-screen"><Brand /><LoaderCircle className="spin" size={20} /><span>正在打开你的工作台…</span></div>;
  if (!session) return <AuthScreen onAuthenticated={(next) => void authenticate(next)} />;

  const page = activeTab === "create" ? <CreateView session={session} models={models} assets={assets} onAssets={updateAssets} onRefreshModels={() => loadModels(session.apiToken)} /> : activeTab === "canvas" ? <CanvasView session={session} models={models} assets={assets} onAssets={updateAssets} onProjectNavigation={() => { if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0; }} /> : activeTab === "assets" ? <AssetsView assets={assets} apiToken={session.apiToken} onDelete={(id) => void deleteAsset(id)} /> : <AccountView session={session} onSession={(next) => { setSession(next); void writeSession(next); }} onTokenChanged={async (next) => { setSession(next); await writeSession(next); await loadModels(next.apiToken); }} onLogout={logout} />;
  return <div className="app-shell"><SideRail activeTab={activeTab} onChange={(tab) => { setActiveTab(tab); setRailOpen(false); }} open={railOpen} /><div className="app-main"><Header user={session.user} activeTab={activeTab} onMenu={() => setRailOpen((value) => !value)} /><div ref={pageScrollRef} className="page-scroll">{modelError && <div className="model-warning"><CircleAlert size={15} />模型列表获取失败：{modelError}<button onClick={() => void loadModels(session.apiToken)}><RefreshCw size={13} /></button></div>}{page}</div><BottomNav activeTab={activeTab} onChange={setActiveTab} /></div>{railOpen && <button className="rail-overlay" aria-label="关闭菜单" onClick={() => setRailOpen(false)} />}</div>;
}
