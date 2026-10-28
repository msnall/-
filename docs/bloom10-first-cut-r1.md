# Bloom10 英语口播：动态初剪 r1

本轮交付用于验收第一条完整视频的字幕、画面、节奏和声音。保留原片顺序、讲话内容和时长；尚未发布到任何平台。

## 查看

- 视频：out/bloom10-first-cut/Bloom10-first-cut-r1.mp4。
- Remotion：在项目根目录运行 npm.cmd run dev，选择 Bloom10FirstCut。
- 如开发服务仍在运行：http://localhost:3000/Bloom10FirstCut。
- 字幕：public/transcripts/Bloom10-达人素材.edited.srt。
- 当前样式：brand/BRAND.md。

## 本轮实现

- 1080×1920、30fps、909帧，视频流30.300秒。MP4容器时长可能因AAC尾部填充多约15毫秒，实际值见验证记录。
- 18条英文字幕，保留 gonna、y'all 等口语，并使用细粒度估计时间强调当前词。
- throw the bottle away 使用本聊天中用户明确确认的修订。重复 I'll 仅合并字幕显示，保留原声。
- 对长句重新排成两行，不缩小58px字幕字号；本地Inter700字体测量最大行宽约718.8px，列宽800px。
- 按已审分镜放置体验开场、粘瓶问题、容器展示和结尾提示。
- 独立包装标签使用真实HyperFrames透明输出，263帧开始，持续60帧；下一段标题等待它结束。
- 数量信息仍有原口播字幕，额外30-DAY SUPPLY图形未启用，等待包装资料核对。
- 原片按已审构图缩进，字幕位于独立区域，字幕和图形不覆盖产品主体与眼睛。

## 声音

原声在副本中经测量后调整至约-16 LUFS，未剪切讲话或重排句子。自制低音量合成背景音不引用外部音乐录音；263帧和515帧各一个短音效。

voice.wav、music.wav、effects.wav 是可独立调整的音轨，mix.wav 是当前混合音轨。数值以 out/bloom10-first-cut/audio-report.json 及最终AAC测量为准。背景音当前比人声约低20 LU；可根据用户反馈调整音色或整体电平。

## 验证文件

- validation.json：最终编码规格、909帧扫描、最终音频响度与峰值、源文件指纹。
- caption-widths.json：实际字体行宽测量。
- all-caption-cues.jpg：全部18条字幕的导出像素抽查。
- six-beat-contact.jpg：六段关键画面的导出像素。
- render.log：实际渲染记录。

字幕时间来自ASR估计而非强制对齐，仍需观看并听校。逐帧灰度扫描用于查找空白及异常重复画面，不能保证检出所有视觉故障。

## 复现

```powershell
Set-Location F:\VideoAutomation
npm.cmd run prepare:bloom10
npm.cmd run lint
npm.cmd run render:bloom10 -- --browser-executable="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm.cmd run verify:bloom10
```

prepare 使用已审原片的SHA-256确认素材身份，生成909张842×1498工作画面，保留每帧对应关系。Remotion读取这些画面合成字幕与图形，减少重复视频解码。混合音轨独立加载，避免源视频声音重复播放。generated工作媒体在public/derived/，已从Git跟踪范围排除，可由脚本重建。

如果只调整声音，可运行 node scripts/prepare-bloom10-first-cut.mjs --audio-only。如果只重建画面帧，可运行同脚本 --proxy-only。

HyperFrames效果、源素材和本地字体须存在于对应目录；恢复到新机器时先按此前环境说明准备。运行中仍可能看到已记录的Zod版本差异提示；本轮功能与渲染检查结果以报告为准。

## 本轮验收重点

1. 开场是否需要缩短，是否保留当前完整口播节奏。
2. 字幕大小、换行、跟随讲话的时间是否舒服。
3. 人声音量、背景音和两处音效是否合适。
4. 粉色浅底构图、顶部标题、独立包装标签是否保留。

收到意见后按本聊天的逐步验收流程修改；本轮不自动继续发布或更换素材。

## 本轮交付检查结果

最终导出自动检查通过：1080×1920、30fps、909帧；视频流30.300秒，MP4容器30.315秒。最终音频约-16.04 LUFS、真峰值-1.44 dBTP。

已查看导出视频的全部18条字幕拼图和六段关键画面；长句换行问题已修正，字幕行在800px区域内。909帧中央画面扫描未发现空白帧，最长完全重复为1帧。此扫描不替代完整观看和听校。当前等待用户验收节奏、字幕同步、音色和视觉风格。
