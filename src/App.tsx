import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  Clock3,
  CircleAlert,
  Copy,
  Download,
  Image as ImageIcon,
  Images,
  KeyRound,
  Lightbulb,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  PanelBottom,
  Plus,
  RefreshCw,
  Rocket,
  Search,
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
import { createVideo, editImage, generateImage, waitForVideo, videoResultUrl, chatCompletion } from "./api/generation";
import { listModels } from "./api/models";
import { ensureCanvasToken } from "./api/tokens";
import { ApiError } from "./api/client";
import { logger } from "./lib/logger";
import { exportAsset } from "./lib/export-asset";
import { clearSession, readAssets, readSession, writeAssets, writeSession } from "./storage";
import CanvasView from "./canvas/CanvasView";
import OptionPicker from "./components/OptionPicker";
import PromptLibrary from "./components/PromptLibrary";
import TokenGroupPicker from "./components/TokenGroupPicker";
import type { AuthSession, GeneratedAsset, Model, TokenGroup, User, VideoTask } from "./types";

type Tab = "create" | "canvas" | "assets" | "account";
type MoreScreen = "menu" | "roadmap" | "feedback" | null;
type CreateMode = "image" | "edit" | "video" | "chat";

const modeMeta: Record<CreateMode, { label: string; icon: typeof ImageIcon }> = {
  image: { label: "生图", icon: ImageIcon },
  edit: { label: "改图", icon: WandSparkles },
  video: { label: "视频", icon: Video },
  chat: { label: "对话", icon: MessageSquareText },
};

function formatQuota(value: number) {
  const amount = value / 500000;
  if (Math.abs(amount) >= 1000) return `¥${(amount / 1000).toFixed(1)}k`;
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
        <span className="quota-chip"><span className="status-dot" />{formatQuota(user.quota)}</span>
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

function BottomNav({ activeTab, onChange, moreOpen, onMore }: { activeTab: Tab; onChange: (tab: Tab) => void; moreOpen: boolean; onMore: () => void }) {
  const items: Array<{ id: Tab; label: string; icon: typeof ImageIcon }> = [
    { id: "create", label: "创作", icon: Sparkles },
    { id: "canvas", label: "画布", icon: PanelBottom },
    { id: "assets", label: "素材", icon: Images },
    { id: "account", label: "账户", icon: UserRound },
  ];
  return <nav className="bottom-nav">{items.map(({ id, label, icon: Icon }) => <button className={activeTab === id ? "is-active" : ""} key={id} onClick={() => onChange(id)}><Icon size={19} /><span>{label}</span></button>)}<button className={moreOpen ? "is-active" : ""} aria-label="更多" aria-expanded={moreOpen} onClick={onMore}><MoreHorizontal size={19} /><span>更多</span></button></nav>;
}

const ROADMAP_ITEMS = [
  { status: "已实现", tone: "done", version: "创作工作台", title: "从想法到生成结果", description: "图片生成与编辑、视频任务、文本对话和模型分组，统一在移动端完成。", tags: ["图片与视频", "模型选择", "提示词库"] },
  { status: "已实现", tone: "done", version: "节点画布", title: "让素材继续流动", description: "素材可加入独立画布，通过节点连线组合文字和多张图片，并将生成结果保存回素材库。", tags: ["节点连线", "多图参考", "本地保存"] },
  { status: "已实现", tone: "done", version: "横屏画布", title: "让画布铺满屏幕", description: "进入沉浸模式后锁定横屏并收起系统栏，也可以随时退出回到普通布局。", tags: ["横屏锁定", "全屏画布", "一键退出"] },
  { status: "当前迭代", tone: "active", version: "移动体验", title: "更清楚，也更舒展", description: "继续打磨模型选择呈现与移动端创作操作。", tags: ["模型选择面板", "移动交互"] },
  { status: "规划中", tone: "planned", version: "视频工作流", title: "从视频继续创作", description: "探索移动端视频关键帧提取，让视频素材也能自然进入节点工作流。", tags: ["关键帧", "视频节点"] },
];

function MoreExperience({ screen, onScreen, onClose }: { screen: Exclude<MoreScreen, null>; onScreen: (screen: MoreScreen) => void; onClose: () => void }) {
  const [feedbackType, setFeedbackType] = useState("功能建议");
  const [feedback, setFeedback] = useState("");
  const [feedbackError, setFeedbackError] = useState("");

  const sendFeedback = (event: FormEvent) => {
    event.preventDefault();
    if (!feedback.trim()) {
      setFeedbackError("请先写下你的建议或遇到的问题");
      return;
    }
    const subject = `Infinite Canvas · ${feedbackType}`;
    const body = [`反馈类型：${feedbackType}`, "", feedback.trim()].join("\n");
    window.location.href = `mailto:zhanglovemikasa@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  if (screen === "menu") return <div className="more-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="more-sheet" role="dialog" aria-modal="true" aria-labelledby="moreTitle">
      <div className="more-sheet-handle" />
      <header className="more-sheet-heading"><div><span className="eyebrow">INFINITE CANVAS</span><strong id="moreTitle">更多</strong></div><button className="more-close" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <button className="more-entry more-entry-roadmap" onClick={() => onScreen("roadmap")}><span className="more-entry-icon"><Rocket size={18} /></span><span><strong>更新计划</strong><small>查看产品迭代与功能进展</small></span><ArrowUpRight size={17} /></button>
      <button className="more-entry more-entry-feedback" onClick={() => onScreen("feedback")}><span className="more-entry-icon"><MessageSquareText size={18} /></span><span><strong>留言建议</strong><small>把想法直接发给产品团队</small></span><ArrowUpRight size={17} /></button>
      <p className="more-sheet-foot">与你一起，把创作工具做得更好。</p>
    </section>
  </div>;

  return <div className="more-page-overlay">
    <header className="more-page-header"><button className="more-back" onClick={() => onScreen("menu")} aria-label="返回"><ArrowLeft size={18} /></button><div><span className="eyebrow">{screen === "roadmap" ? "PRODUCT ROADMAP" : "YOUR VOICE MATTERS"}</span><strong>{screen === "roadmap" ? "更新计划" : "留言建议"}</strong></div><button className="more-close" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
    {screen === "roadmap" ? <div className="more-page-scroll roadmap-page">
      <section className="roadmap-hero"><div className="roadmap-hero-copy"><span>BUILT WITH YOU</span><h1>每一步，<br />都让创作更自由。</h1><p>持续迭代，让灵感从模型走进画布。</p></div><div className="roadmap-art" aria-hidden="true"><i className="roadmap-wire roadmap-wire-one" /><i className="roadmap-wire roadmap-wire-two" /><b className="roadmap-tile roadmap-tile-one" /><b className="roadmap-tile roadmap-tile-main"><Sparkles size={22} /></b><b className="roadmap-tile roadmap-tile-last" /><i className="roadmap-dot" /></div><div className="roadmap-hero-footer"><span>PRODUCT JOURNEY</span><span>不断更新 <i /></span></div></section>
      <div className="roadmap-section-heading"><div><span className="eyebrow">WHAT'S NEXT</span><h2>产品迭代</h2></div><span>持续更新</span></div>
      <div className="roadmap-timeline">{ROADMAP_ITEMS.map((item, index) => <article className={`roadmap-item roadmap-item-${item.tone}`} key={item.version}><div className="roadmap-marker"><span>{index < 2 ? <Check size={13} /> : index === 2 ? <Clock3 size={13} /> : <Lightbulb size={13} />}</span></div><div className="roadmap-item-content"><div className="roadmap-item-top"><span>{item.version}</span><span className="roadmap-status">{item.status}</span></div><h3>{item.title}</h3><p>{item.description}</p><div className="roadmap-tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div></article>)}</div>
      <div className="roadmap-note"><Lightbulb size={16} /><p>路线会根据实际使用反馈持续调整，状态和顺序也可能变化。</p></div>
    </div> : <div className="more-page-scroll feedback-page">
      <section className="feedback-intro"><span className="feedback-symbol"><MessageSquareText size={21} /></span><span className="eyebrow">MAKE IT BETTER</span><h1>你的想法，<br />值得被听见。</h1><p>告诉我们你希望改进的地方，或遇到的问题。</p></section>
      <form className="feedback-form" onSubmit={sendFeedback}>
        <label className="field-label">反馈类型</label><OptionPicker label="反馈类型" value={feedbackType} onChange={setFeedbackType} options={[{ value: "功能建议", label: "功能建议" }, { value: "问题反馈", label: "问题反馈" }, { value: "其他留言", label: "其他留言" }]} />
        <label htmlFor="feedbackBody">留言内容</label><textarea id="feedbackBody" value={feedback} onChange={(event) => { setFeedback(event.target.value); setFeedbackError(""); }} maxLength={2000} placeholder="写下你希望我们知道的内容…" rows={6} required />
        <div className="feedback-count">{feedback.length} / 2000</div>
        {feedbackError && <div className="notice notice-error"><CircleAlert size={14} />{feedbackError}</div>}
        <div className="feedback-recipient"><Mail size={15} /><span>发送至</span><strong>zhanglovemikasa@gmail.com</strong></div>
        <button className="button button-primary feedback-submit" type="submit"><Send size={15} />打开邮件发送</button>
        <p className="feedback-footnote">将打开设备上的邮件应用，你可以检查内容后发送。</p>
      </form>
    </div>}
  </div>;
}

function CreateView({ session, models, assets, onAssets, onRefreshModels, prompt, onPromptChange }: { session: AuthSession; models: Model[]; assets: GeneratedAsset[]; onAssets: (assets: GeneratedAsset[]) => void; onRefreshModels: () => Promise<void>; prompt: string; onPromptChange: (prompt: string) => void }) {
  const [mode, setMode] = useState<CreateMode>("image");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("1:1");
  const [quality, setQuality] = useState("auto");
  const [count, setCount] = useState(1);
  const [references, setReferences] = useState<Array<{ url: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [chatAnswer, setChatAnswer] = useState("");
  const [videoTask, setVideoTask] = useState<VideoTask | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const videoAbortRef = useRef<AbortController | null>(null);
  const videoTaskIdRef = useRef("");

  useEffect(() => () => videoAbortRef.current?.abort(), []);

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
    const next = await writeAssets([...newAssets, ...assets], session.apiToken);
    onAssets(next);
  };

  const cancelVideoWait = () => videoAbortRef.current?.abort();

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
    videoTaskIdRef.current = "";
    try {
      if (mode === "image") {
        setStatus("正在绘制画面…");
        await saveNewAssets(await generateImage(session.apiToken, model, prompt.trim(), { size, quality, count }, setStatus));
        setStatus("已保存到素材");
      } else if (mode === "edit") {
        if (!references.length) throw new Error("改图需要先上传参考图");
        setStatus("正在重组画面…");
        await saveNewAssets(await editImage(session.apiToken, model, prompt.trim(), references.map((item) => item.url), undefined, count, setStatus));
        setStatus("编辑结果已保存到素材");
      } else if (mode === "video") {
        const controller = new AbortController();
        videoAbortRef.current = controller;
        const task = await createVideo(session.apiToken, model, prompt.trim(), references[0]?.url, controller.signal, setStatus);
        videoTaskIdRef.current = task.id;
        setVideoTask(task);
        setStatus("任务已创建，正在等待上游完成…");
        const completedTask = await waitForVideo(session.apiToken, task.id, { signal: controller.signal, onTask: setVideoTask, onStatus: setStatus });
        await saveNewAssets([{ id: `video-${task.id}`, kind: "video", url: videoResultUrl(completedTask), model, prompt: prompt.trim(), createdAt: Date.now() }]);
        setStatus("视频已保存到素材");
      } else {
        setStatus("正在思考…");
        const response = await chatCompletion(session.apiToken, model, [{ role: "user", content: prompt.trim() }]);
        const text = response.choices?.[0]?.message?.content || "模型没有返回文字";
        setChatAnswer(text);
        await saveNewAssets([{ id: `text-${Date.now()}`, kind: "text", url: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`, model, prompt, content: text, createdAt: Date.now() }]);
        setStatus("回答已保存");
      }
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === "aborted") {
        logger.info("generation:video:cancelled", { taskId: videoTaskIdRef.current || undefined });
        setError("");
        setStatus("已取消等待，上游任务可能仍会继续");
      } else {
        logger.error("generation:failed", { mode, model, error: getErrorMessage(requestError), status: requestError instanceof ApiError ? requestError.status : undefined, code: requestError instanceof ApiError ? requestError.code : undefined });
        setError(getErrorMessage(requestError));
        setStatus("");
      }
    } finally {
      videoAbortRef.current = null;
      setBusy(false);
    }
  };

  const modeDescription = mode === "image" ? "从一句话开始，生成一组可继续编辑的画面。" : mode === "edit" ? "上传参考图，用自然语言改变局部或整体。" : mode === "video" ? "把提示词或参考图交给视频模型，等待任务完成。" : "把问题交给模型，回答会存进你的素材库。";
  return <section className="page create-page">
    <div className="page-heading"><div><p className="eyebrow">CREATE / {String(mode).toUpperCase()}</p><h1>今天，做点新的。</h1><p>{modeDescription}</p></div><Button className="refresh-button" onClick={() => void onRefreshModels()}><RefreshCw size={16} />刷新模型</Button></div>
    <div className="mode-tabs">{(Object.keys(modeMeta) as CreateMode[]).map((item) => { const Icon = modeMeta[item].icon; return <button key={item} className={mode === item ? "is-active" : ""} onClick={() => { setMode(item); setError(""); }}><Icon size={17} />{modeMeta[item].label}</button>; })}</div>
    <form className="create-layout" onSubmit={submit}>
      <div className="prompt-panel panel">
        <div className="panel-topline"><span className="panel-index">01</span><span>描述你的想法</span><span className="panel-spacer" /><span className="live-label"><span className="status-dot" />LIVE</span></div>
        <textarea value={prompt} onChange={(event) => onPromptChange(event.target.value)} placeholder={mode === "chat" ? "问一个问题，或者描述你需要的方案…" : mode === "video" ? "例如：雨夜的东京街头，镜头缓慢向前推进…" : "例如：一间有天窗的工作室，清晨的光落在木桌上…"} rows={7} />
        <div className="prompt-footer"><span>{prompt.length} / 2000</span><Button className="clear-button" onClick={() => onPromptChange("")}><Trash2 size={14} />清空</Button></div>
      </div>
      <div className="settings-panel panel">
        <div className="panel-topline"><span className="panel-index">02</span><span>生成设置</span></div>
        <Field label="模型">
          <OptionPicker label="模型" value={model} onChange={setModel} placeholder="暂无可用模型" disabled={!availableModels.length} options={availableModels.map((item) => ({ value: item.id, label: item.id }))} />
        </Field>
        {(mode === "image" || mode === "edit") && <div className="setting-grid"><Field label="画幅"><OptionPicker label="画幅" value={size} onChange={setSize} options={[{ value: "1:1", label: "1:1 方形" }, { value: "16:9", label: "16:9 横向" }, { value: "9:16", label: "9:16 竖向" }, { value: "4:3", label: "4:3 标准" }]} /></Field><Field label="质量"><OptionPicker label="质量" value={quality} onChange={setQuality} options={[{ value: "auto", label: "自动" }, { value: "low", label: "低" }, { value: "medium", label: "中" }, { value: "high", label: "高" }]} /></Field></div>}
        {(mode === "image" || mode === "edit") && <Field label="张数" hint={`${count} 张`}><input type="range" min="1" max="4" value={count} onChange={(event) => setCount(Number(event.target.value))} /></Field>}
        {(mode === "edit" || mode === "video") && <div className="reference-block"><div className="field-label">参考图片{mode === "edit" ? " · 可多选" : ""}</div><button type="button" className="upload-zone" onClick={() => fileInput.current?.click()}><Upload size={18} /><span>{references.length ? "继续添加图片" : "点击选择图片"}</span><small>{references.length ? `已选 ${references.length} 张` : "PNG / JPG / WebP"}</small></button>{Boolean(references.length) && <div className="reference-thumbnails">{references.map((item, index) => <div key={`${item.name}-${index}`}><img src={item.url} alt={item.name} /><button type="button" onClick={() => setReferences((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除${item.name}`}><X size={13} /></button></div>)}</div>}<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple={mode === "edit"} hidden onChange={(event) => { void pickFiles(event.target.files); event.currentTarget.value = ""; }} /></div>}
        {error && <div className="notice notice-error"><CircleAlert size={15} />{error}</div>}
        <Button type="submit" variant="primary" className="generate-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}{busy ? status || "处理中" : mode === "chat" ? "发送给模型" : mode === "video" ? "开始生成视频" : mode === "edit" ? "开始编辑" : "生成图片"}<ArrowUpRight size={17} /></Button>
        {status && !error && <p className="action-status"><span className={busy ? "pulse-dot" : "status-dot"} />{status}</p>}
      </div>
    </form>
    {(videoTask || busy && mode === "video") && <div className="task-strip"><div><span className="eyebrow">VIDEO TASK</span><strong>{videoTask?.id || "正在创建任务"}</strong></div><span className={`task-status ${videoTask?.status === "completed" ? "done" : ""}`}><span className="status-dot" />{videoTask?.status || "processing"}</span>{busy && <Button className="task-cancel" onClick={cancelVideoWait}><X size={14} />取消等待</Button>}</div>}
    {chatAnswer && <div className="answer-panel panel"><div className="panel-topline"><span className="panel-index">OUT</span><span>模型回答</span><Button onClick={() => void navigator.clipboard?.writeText(chatAnswer)}><Copy size={14} />复制</Button></div><p>{chatAnswer}</p></div>}
    <div className="recent-strip"><div className="section-title"><div><span className="eyebrow">RECENT OUTPUTS</span><h2>最近生成</h2></div><span>{assets.length} 项</span></div><div className="recent-grid">{assets.slice(0, 4).map((asset) => <AssetThumb asset={asset} key={asset.id} onExport={(item) => void handleAssetExport(item, session.apiToken)} />)}{!assets.length && <div className="empty-inline"><Sparkles size={17} />你的第一张作品会出现在这里</div>}</div></div>
  </section>;
}

function AssetThumb({ asset, onDelete, onExport }: { asset: GeneratedAsset; onDelete?: () => void; onExport?: (asset: GeneratedAsset) => void }) {
  return <article className={`asset-thumb asset-${asset.kind}`}>
    {asset.kind === "image" ? <img src={asset.url} alt={asset.prompt} /> : asset.kind === "video" ? <video src={asset.url} muted playsInline preload="metadata" /> : <div className="text-thumb"><MessageSquareText size={18} /><p>{asset.content || asset.prompt}</p></div>}
    <div className="asset-thumb-meta"><span>{asset.model}</span><div>{onExport && <button className="asset-export-button" onClick={() => onExport(asset)} aria-label="导出素材" title="导出素材"><Download size={14} /></button>}{onDelete && <button onClick={onDelete} aria-label="删除素材"><Trash2 size={14} /></button>}</div></div>
  </article>;
}

function AssetsView({ assets, apiToken, onAssets, onDelete, onSelectPrompt }: { assets: GeneratedAsset[]; apiToken: string; onAssets: (assets: GeneratedAsset[]) => void; onDelete: (id: string) => void; onSelectPrompt: (prompt: string) => void }) {
  const [filter, setFilter] = useState<"all" | GeneratedAsset["kind"]>("all");
  const [collection, setCollection] = useState<"library" | "history">("library");
  const [search, setSearch] = useState("");
  const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const libraryAssets = assets.filter((asset) => asset.inLibrary !== false);
  const sourceAssets = collection === "library" ? libraryAssets : assets;
  const filtered = sourceAssets.filter((asset) => (filter === "all" || asset.kind === filter) && `${asset.prompt} ${asset.content || ""} ${asset.model}`.toLowerCase().includes(search.trim().toLowerCase()));
  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setImporting(true);
    setImportError("");
    try {
      const imported = (await Promise.all(Array.from(files).map(async (file, index): Promise<GeneratedAsset | null> => {
        const id = `local-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
        if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
          return { id, kind: file.type.startsWith("video/") ? "video" : "image", url: await readFileAsDataUrl(file), model: "本地导入", prompt: file.name, createdAt: Date.now(), inLibrary: true };
        }
        if (file.type.startsWith("text/") || /\.txt$/i.test(file.name)) {
          const content = await file.text();
          return { id, kind: "text", url: `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`, model: "本地导入", prompt: file.name, content, createdAt: Date.now(), inLibrary: true };
        }
        return null;
      }))).filter((asset): asset is GeneratedAsset => Boolean(asset));
      if (!imported.length) throw new Error("只支持图片、视频或 TXT 文本文件");
      onAssets(await writeAssets([...imported, ...assets], apiToken));
    } catch (error) {
      setImportError(getErrorMessage(error));
    } finally {
      setImporting(false);
    }
  };
  return <section className="page assets-page">
    <div className="page-heading"><div><p className="eyebrow">{collection === "library" ? `LIBRARY / ${libraryAssets.length} ITEMS` : `HISTORY / ${assets.length} ITEMS`}</p><h1>{collection === "library" ? "你的素材。" : "生成历史。"}</h1><p>所有生成结果都只保存在这台设备上。</p></div><Button variant="dark" onClick={() => importInput.current?.click()} disabled={importing}>{importing ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}{importing ? "导入中" : "导入素材"}</Button><input ref={importInput} type="file" accept="image/*,video/*,text/plain,.txt" multiple hidden onChange={(event) => { void importFiles(event.target.files); event.currentTarget.value = ""; }} /></div>
    <div className="asset-collection-tabs" role="tablist" aria-label="素材视图">
      <button type="button" role="tab" aria-selected={collection === "library"} className={collection === "library" ? "is-active" : ""} onClick={() => setCollection("library")}>素材库<span>{libraryAssets.length}</span></button>
      <button type="button" role="tab" aria-selected={collection === "history"} className={collection === "history" ? "is-active" : ""} onClick={() => setCollection("history")}>生成历史<span>{assets.length}</span></button>
    </div>
    <label className="asset-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索提示词或模型" /></label>
    <div className="filter-tabs">
      {(["all", "image", "video", "text"] as const).map((value) => <button key={value} className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>{value === "all" ? "全部" : value === "image" ? "图片" : value === "video" ? "视频" : "文字"}<span>{value === "all" ? sourceAssets.length : sourceAssets.filter((asset) => asset.kind === value).length}</span></button>)}
      <button type="button" className="prompt-library-tab" onClick={() => setPromptLibraryOpen(true)}><BookOpen size={14} />提示词库</button>
    </div>
    {importError && <div className="notice notice-error"><CircleAlert size={15} />{importError}</div>}
    <div className="asset-grid">{filtered.map((asset) => <AssetThumb key={asset.id} asset={asset} onExport={(item) => void handleAssetExport(item, apiToken)} onDelete={collection === "library" ? () => onDelete(asset.id) : undefined} />)}{!filtered.length && <div className="empty-state"><Images size={31} /><strong>{search ? "没有匹配的记录" : collection === "library" ? "这里还没有素材" : "还没有生成记录"}</strong><span>{collection === "library" ? "回到创作页，做出第一件作品。" : "完成的图片、视频和对话会保留在这里。"}</span></div>}</div>
    {promptLibraryOpen && <PromptLibrary onClose={() => setPromptLibraryOpen(false)} onSelect={onSelectPrompt} />}
  </section>;
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
  const remainingQuota = session.user.quota;
  const totalQuota = remainingQuota + session.user.usedQuota;
  const quotaProgress = totalQuota > 0 ? Math.min(100, Math.max(0, (remainingQuota / totalQuota) * 100)) : 0;
  return <section className="page account-page"><div className="page-heading"><div><p className="eyebrow">ACCOUNT / NEW API</p><h1>你的工作台账户。</h1><p>额度、模型和请求都由 mikasa.icu 统一管理。</p></div><Button onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} size={16} />刷新</Button></div><div className="account-grid"><div className="account-card profile-card"><div className="profile-top"><div className="profile-avatar">{(session.user.displayName || session.user.username || "U").slice(0, 1).toUpperCase()}</div><div><span className="eyebrow">SIGNED IN AS</span><h2>{session.user.displayName || session.user.username}</h2><p>@{session.user.username}</p></div></div><div className="profile-line"><span>邮箱</span><strong>{session.user.email || "未填写"}</strong></div><div className="profile-line"><span>API 状态</span><strong className="online"><span className="status-dot" />已连接</strong></div></div><div className="account-card quota-card"><span className="eyebrow">REMAINING QUOTA</span><strong>{formatQuota(remainingQuota)}</strong><div className="quota-track"><i style={{ width: `${quotaProgress}%` }} /></div><p>已使用 {formatQuota(session.user.usedQuota)} / 总额度 {formatQuota(totalQuota)}</p></div><div className="account-card token-card"><div className="card-heading"><div><span className="eyebrow">PRIVATE TOKEN</span><h3>Infinite Canvas</h3></div><KeyRound size={19} /></div><p>你的生成请求使用 New API 用户 Token。完整 Key 不会在界面展示。</p><TokenGroupPicker groups={groups} value={session.apiTokenGroup || ""} disabled={groupBusy} onChange={(group) => void changeGroup(group)} /><div className="token-mask">•••• •••• •••• {String(session.apiToken).slice(-4)}</div><div className="token-foot"><span><Check size={14} />安全存储</span><span>请求 {session.user.requestCount} 次</span></div></div></div>{groupError && <div className="notice notice-error"><CircleAlert size={15} />{groupError}</div>}{message && <div className="notice notice-success"><Check size={15} />{message}</div>}<div className="account-actions"><Button><Settings2 size={16} />偏好设置</Button><Button onClick={() => void onLogout()} className="logout-button"><LogOut size={16} />退出登录</Button></div></section>;
}

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("create");
  const [moreScreen, setMoreScreen] = useState<MoreScreen>(null);
  const [promptDraft, setPromptDraft] = useState("");
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
      try {
        const [storedSession, storedAssets] = await Promise.all([readSession(), readAssets()]);
        setAssets(storedAssets);
        if (!storedSession) return;

        let next = storedSession;
        let sessionExpired = false;
        try {
          next = { ...next, user: await fetchCurrentUser(next.accessToken) };
        } catch (error) {
          logger.warn("session:restore:user:failed", { error: getErrorMessage(error) });
          if (error instanceof ApiError && error.status === 401) {
            try {
              const refreshed = await refreshSession(next.accessToken, next.sessionId);
              next = { ...next, ...refreshed, user: storedSession.user, apiToken: storedSession.apiToken, apiTokenId: storedSession.apiTokenId, apiTokenGroup: storedSession.apiTokenGroup };
              try {
                next = { ...next, user: await fetchCurrentUser(next.accessToken) };
              } catch (userError) {
                logger.warn("session:restore:refreshed-user:failed", { error: getErrorMessage(userError) });
                sessionExpired = userError instanceof ApiError && userError.status === 401;
              }
            } catch (refreshError) {
              logger.warn("session:restore:refresh:failed", { error: getErrorMessage(refreshError) });
              sessionExpired = refreshError instanceof ApiError && refreshError.status === 401;
            }
          }
        }

        if (sessionExpired) {
          await clearSession();
          return;
        }

        try {
          const group = await resolveTokenGroup(next.accessToken, next.user.group || "", next.apiTokenGroup || "");
          const token = await ensureCanvasToken(next.accessToken, group);
          next = { ...next, apiToken: token.key, apiTokenId: token.token.id, apiTokenGroup: token.token.group };
        } catch (error) {
          logger.warn("session:restore:api-token:failed", { error: getErrorMessage(error) });
        }

        setSession(next);
        await writeSession(next).catch((error) => logger.warn("session:restore:save:failed", { error: getErrorMessage(error) }));
        await loadModels(next.apiToken);
      } catch (error) {
        logger.error("app:startup:failed", { error: getErrorMessage(error) });
      } finally {
        setBooting(false);
      }
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
    if (!session) return;
    const next = assets.map((asset) => asset.id === id ? { ...asset, inLibrary: false } : asset);
    try {
      setAssets(await writeAssets(next, session.apiToken));
    } catch (error) {
      window.alert(getErrorMessage(error));
    }
  };

  if (booting) return <div className="boot-screen"><Brand /><LoaderCircle className="spin" size={20} /><span>正在打开你的工作台…</span></div>;
  if (!session) return <AuthScreen onAuthenticated={(next) => void authenticate(next)} />;

  const page = activeTab === "create" ? <CreateView session={session} models={models} assets={assets} onAssets={updateAssets} onRefreshModels={() => loadModels(session.apiToken)} prompt={promptDraft} onPromptChange={setPromptDraft} /> : activeTab === "canvas" ? <CanvasView session={session} models={models} assets={assets} onAssets={updateAssets} onProjectNavigation={() => { if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0; }} /> : activeTab === "assets" ? <AssetsView assets={assets} apiToken={session.apiToken} onAssets={updateAssets} onDelete={(id) => void deleteAsset(id)} onSelectPrompt={(value) => { setPromptDraft((current) => current.trim() ? `${current.trim()}\n\n${value}` : value); setActiveTab("create"); }} /> : <AccountView session={session} onSession={(next) => { setSession(next); void writeSession(next); }} onTokenChanged={async (next) => { setSession(next); await writeSession(next); await loadModels(next.apiToken); }} onLogout={logout} />;
  return <div className="app-shell"><SideRail activeTab={activeTab} onChange={(tab) => { setActiveTab(tab); setMoreScreen(null); setRailOpen(false); }} open={railOpen} /><div className="app-main"><Header user={session.user} activeTab={activeTab} onMenu={() => setRailOpen((value) => !value)} /><div ref={pageScrollRef} className="page-scroll">{modelError && <div className="model-warning"><CircleAlert size={15} />模型列表获取失败：{modelError}<button onClick={() => void loadModels(session.apiToken)}><RefreshCw size={13} /></button></div>}{page}</div><BottomNav activeTab={activeTab} onChange={(tab) => { setActiveTab(tab); setMoreScreen(null); }} moreOpen={moreScreen !== null} onMore={() => setMoreScreen((current) => current ? null : "menu")} /></div>{railOpen && <button className="rail-overlay" aria-label="关闭菜单" onClick={() => setRailOpen(false)} />}{moreScreen && <MoreExperience screen={moreScreen} onScreen={setMoreScreen} onClose={() => setMoreScreen(null)} />}</div>;
}
