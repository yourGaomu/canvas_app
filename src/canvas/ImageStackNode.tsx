import { ChevronDown, ChevronUp } from "lucide-react";
import type { GeneratedAsset } from "../types";

export default function ImageStackNode({ assets, primaryId, expanded, openLeft, onToggle, onChoose }: { assets: GeneratedAsset[]; primaryId: string; expanded: boolean; openLeft: boolean; onToggle: () => void; onChoose: (assetId: string) => void }) {
  const primary = assets.find((asset) => asset.id === primaryId) || assets[0];
  const alternatives = assets.filter((asset) => asset.id !== primary?.id);
  return <div className={`canvas-image-stack ${expanded ? "is-expanded" : ""} ${openLeft ? "opens-left" : ""}`}>
    <div className="canvas-image-stack-cover">
      {alternatives.slice(0, 3).reverse().map((asset, index) => <img key={asset.id} src={asset.url} alt="" className="canvas-image-stack-layer" style={{ transform: `translate(${(index + 1) * 4}px, ${-(index + 1) * 4}px)` }} />)}
      {primary && <img src={primary.url} alt={primary.prompt} className="canvas-image-stack-primary" draggable={false} />}
      <button className="canvas-image-stack-count" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onToggle(); }} aria-label={expanded ? "收起生成图片" : "展开生成图片"}>{assets.length} 张 {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</button>
    </div>
    {expanded && <div className="canvas-image-stack-grid" onPointerDown={(event) => event.stopPropagation()}>{assets.map((asset, index) => <button type="button" key={asset.id} className={asset.id === primary?.id ? "is-primary" : ""} onClick={(event) => { event.stopPropagation(); onChoose(asset.id); }}><img src={asset.url} alt={`结果 ${index + 1}`} /><span>{asset.id === primary?.id ? "主图" : `结果 ${index + 1}`}</span></button>)}</div>}
  </div>;
}
