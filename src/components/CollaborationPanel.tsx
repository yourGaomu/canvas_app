import { useState } from "react";
import { Share } from "@capacitor/share";
import { Check, CircleAlert, Copy, LoaderCircle, RotateCw, UsersRound, Wifi, X } from "lucide-react";
import type { CanvasCollaborationEvent, CanvasPresence } from "../collaboration/canvas-document";
import type { CollaborationRole } from "../api/collaboration";

type Props = {
  roomId: string;
  role: CollaborationRole;
  status: CanvasCollaborationEvent;
  connectionError: string;
  presence: CanvasPresence[];
  onClose: () => void;
  onRetry: () => void;
  onInvite: (username: string, role: "editor" | "readonly") => Promise<void>;
};

const STATUS_LABEL: Record<CanvasCollaborationEvent, string> = {
  connecting: "正在连接",
  connected: "连接已建立",
  syncing: "正在同步画布",
  disconnected: "已断开",
  synced: "已同步",
  error: "连接失败",
};

export default function CollaborationPanel({ roomId, role, status, connectionError, presence, onClose, onRetry, onInvite }: Props) {
  const [username, setUsername] = useState("");
  const [memberRole, setMemberRole] = useState<"editor" | "readonly">("editor");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const syncActive = status === "connecting" || status === "connected" || status === "syncing";

  const invite = async () => {
    const value = username.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await onInvite(value, memberRole);
      setUsername("");
      setMessage(`已邀请 ${value}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "邀请失败");
    } finally {
      setBusy(false);
    }
  };

  const shareRoom = async () => {
    try {
      await Share.share({ title: "邀请加入画布", text: `Infinite Canvas 协作房间：${roomId}` });
    } catch {
      try {
        await navigator.clipboard.writeText(roomId);
        setMessage("房间号已复制");
      } catch {
        setError("无法打开系统分享，请手动复制房间号");
      }
    }
  };

  return <div className="canvas-collaboration-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="canvas-collaboration-panel" role="dialog" aria-modal="true" aria-labelledby="canvas-collaboration-title">
      <div className="canvas-collaboration-heading"><div><span className="eyebrow">SHARED CANVAS</span><h2 id="canvas-collaboration-title">协作成员</h2></div><button type="button" onClick={onClose} aria-label="关闭协作面板"><X size={18} /></button></div>
      <div className="canvas-collaboration-status"><span className={`canvas-collaboration-indicator is-${status}`}><Wifi size={15} /></span><span>{STATUS_LABEL[status]}</span><small>{presence.length} 人在线</small></div>
      <div className={`canvas-collaboration-progress ${syncActive ? "is-active" : ""} ${status === "synced" ? "is-complete" : ""} ${status === "error" ? "is-error" : ""}`} role="progressbar" aria-label="画布同步进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status === "synced" ? 100 : undefined} aria-valuetext={STATUS_LABEL[status]}><span /></div>
      {connectionError && <div className="notice notice-error canvas-collaboration-connection-error"><CircleAlert size={14} /><span>{connectionError}</span><button className="button" type="button" onClick={onRetry}><RotateCw size={14} />重新连接</button></div>}
      <div className="canvas-collaboration-room"><div><span>房间号</span><code>{roomId}</code></div><button type="button" onClick={() => void shareRoom()} title="分享房间号" aria-label="分享房间号"><Copy size={16} /></button></div>
      <div className="canvas-collaboration-members"><span className="canvas-collaboration-section-title"><UsersRound size={14} />当前在线</span>{presence.map((member) => <div className="canvas-collaboration-member" key={member.clientId}><span className="canvas-collaboration-avatar">{member.user.name.slice(0, 1).toUpperCase()}</span><span>{member.user.name}</span><small>{member.nodeIds.length ? "正在移动节点" : "在线"}</small></div>)}</div>
      {role === "owner" && <div className="canvas-collaboration-invite"><span className="canvas-collaboration-section-title">邀请账户</span><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="输入对方的 NewAPI 用户名" autoComplete="off" /><div><label><span>权限</span><select value={memberRole} onChange={(event) => setMemberRole(event.target.value as "editor" | "readonly")}><option value="editor">可编辑</option><option value="readonly">只读</option></select></label><button type="button" className="button button-primary" onClick={() => void invite()} disabled={busy || !username.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}添加成员</button></div></div>}
      {role !== "owner" && <p className="canvas-collaboration-footnote">你拥有{role === "readonly" ? "只读" : "编辑"}权限。</p>}
      <p className="canvas-collaboration-footnote">图片和视频仍保存在各自设备；共享素材上传将在后续阶段接入。</p>
      {message && <div className="notice notice-success"><Check size={14} />{message}</div>}{error && <div className="notice notice-error"><CircleAlert size={14} />{error}</div>}
    </section>
  </div>;
}
