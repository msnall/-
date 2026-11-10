import type { RawPlan, StoryboardSelection } from "./api.ts";

type Settings = NonNullable<StoryboardSelection["videoSettings"]>;
type Box = { x: number; y: number; width: number; height: number };
export const VideoSettingsPanel: React.FC<{ plan: RawPlan | null; value: Settings; isMix: boolean; disabled: boolean; onChange: (next: Settings) => void; onRefreshPresenter?: () => void }> = ({ plan, value, isMix, disabled, onChange, onRefreshPresenter }) => {
  const output = plan?.output as { width?: number; height?: number } | undefined;
  const width = output?.width ?? 1080, height = output?.height ?? 1920;
  const caption = value.captions ?? {};
  const presenter = value.presenter ?? {};
  const captionBox: Box = caption.box ?? plan?.captions?.box ?? { x: 70, y: isMix ? 840 : 1330, width: 860, height: 190 };
  const overlay = plan?.overlays?.find((item) => item.id === "mix-presenter");
  const personBox: Box = presenter.box ?? (overlay ? { x: Number(overlay.props.x), y: Number(overlay.props.y), width: Number(overlay.props.width), height: Number(overlay.props.height) } : { x: 590, y: 1060, width: 300, height: 534 });
  const captions = (change: Partial<NonNullable<Settings["captions"]>>) => onChange({ ...value, captions: { ...caption, ...change } });
  const person = (change: Partial<NonNullable<Settings["presenter"]>>) => onChange({ ...value, presenter: { ...presenter, ...change } });
  const fit = (box: Box): Box => ({ ...box, x: Math.min(Math.max(0, box.x), Math.max(0, width - box.width)), y: Math.min(Math.max(0, box.y), Math.max(0, height - box.height)) });
  const slider = (label: string, current: number, min: number, max: number, change: (number: number) => void) => <label className="video-setting-slider"><span>{label}<output>{Math.round(current)}</output></span><input aria-label={label} type="range" min={min} max={max} step={1} value={current} onChange={(event) => change(Number(event.target.value))} /></label>;
  const color = (label: string, current: string, change: (color: string) => void) => <label className="video-setting-color"><span>{label}</span><input aria-label={label} type="color" value={current.slice(0, 7)} onChange={(event) => change(event.target.value)} /></label>;
  return <div className="video-settings-panel"><h2>字幕与达人</h2><p>设置应用于整条视频，切换镜头时保持一致。</p>{isMix && onRefreshPresenter ? <button onClick={onRefreshPresenter}>自动识别并更新达人抠像</button> : null}{disabled ? <p className="notice">方案已确认，创建自定义方案后可继续调整。</p> : null}
    <fieldset disabled={disabled}><legend>字幕</legend><label className="video-setting-check"><input type="checkbox" checked={caption.enabled !== false} onChange={(event) => captions({ enabled: event.target.checked })} />显示字幕</label>
      <div className="video-setting-presets"><button onClick={() => captions({ enabled: true, fontSize: 62, color: "#ffffff", activeColor: "#ffd23f", background: null })}>关键词高亮</button><button onClick={() => captions({ enabled: true, fontSize: 58, color: "#ffffff", activeColor: "#ffffff", background: "#101820b3" })}>白字黑底</button><button onClick={() => captions({ enabled: true, fontSize: 54, color: "#ffffff", activeColor: "#ffffff", background: null })}>简洁白字</button></div>
      {slider("字幕大小", caption.fontSize ?? plan?.captions?.fontSize ?? 62, 16, 180, (fontSize) => captions({ fontSize, box: fit({ ...captionBox, height: Math.max(190, Math.ceil(fontSize * 2.4)) }) }))}
      {slider("字幕左右位置", captionBox.x, 0, Math.max(0, width - captionBox.width), (x) => captions({ box: fit({ ...captionBox, x }) }))}
      {slider("字幕上下位置", captionBox.y, 0, Math.max(0, height - captionBox.height), (y) => captions({ box: fit({ ...captionBox, y }) }))}
      {slider("字幕宽度", captionBox.width, Math.min(300, width), width, (next) => captions({ box: fit({ ...captionBox, width: next }) }))}
      <div className="video-setting-presets"><button onClick={() => captions({ box: fit({ ...captionBox, x: (width - captionBox.width) / 2, y: height * .25 }) })}>上方</button><button onClick={() => captions({ box: fit({ ...captionBox, x: (width - captionBox.width) / 2, y: height * .44 }) })}>中间</button><button onClick={() => captions({ box: fit({ ...captionBox, x: (width - captionBox.width) / 2, y: height * .70 }) })}>下方</button></div>
      {color("字幕颜色", caption.color ?? plan?.captions?.color ?? "#ffffff", (textColor) => captions({ color: textColor }))}
      {color("高亮颜色", caption.activeColor ?? plan?.captions?.activeColor ?? "#ffd23f", (activeColor) => captions({ activeColor }))}
    </fieldset>
    {isMix ? <fieldset disabled={disabled}><legend>达人</legend><label className="video-setting-check"><input type="checkbox" checked={presenter.enabled !== false} onChange={(event) => person({ enabled: event.target.checked })} />显示达人</label>
      {slider("达人大小", personBox.width, 120, Math.min(800, width), (next) => person({ box: fit({ ...personBox, width: next, height: next * personBox.height / personBox.width }) }))}
      {slider("达人左右位置", personBox.x, 0, Math.max(0, width - personBox.width), (x) => person({ box: fit({ ...personBox, x }) }))}
      {slider("达人上下位置", personBox.y, 0, Math.max(0, height - personBox.height), (y) => person({ box: fit({ ...personBox, y }) }))}
      <div className="video-setting-presets"><button onClick={() => person({ box: fit({ ...personBox, x: width * .08 }) })}>靠左</button><button onClick={() => person({ box: fit({ ...personBox, x: width * .5 - personBox.width / 2 }) })}>居中</button><button onClick={() => person({ box: fit({ ...personBox, x: width * .82 - personBox.width }) })}>靠右</button></div>
    </fieldset> : null}
  </div>;
};
