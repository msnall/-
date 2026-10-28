# HyperFrames 标签效果验收

本步已完成本地 CLI、浏览器、透明渲染与合成样片验证。效果尚未加入完整第一版视频，等待用户验收。

## 验证结果

- HyperFrames 0.8.206；Node.js 24.22.1；FFmpeg / FFprobe 可用。
- doctor 识别到已安装 Chrome；实际渲染使用缓存 HeadlessChrome/152.0.7977.30、hardware GPU / drawElement capture。
- 1080×1920、30fps、60 帧、2.000 秒。
- WebM / VP9 透明原件导出成功；不仅检查 alpha 标签，还解码验证外部 alpha=0、标签内部 alpha=255。
- MP4 / H.264 合成样片同样为 60 帧、2 秒，并含原片音轨。
- 运行、布局、动画断言和对比度检查均为 0 错误。
- 两条 craft 提示已审查：透明片段首帧为空、文字淡入淡出后可见时长不足独立结尾卡的 2 秒要求。该片段作为主视频上的短标签，因此保留预期淡入淡出。

## 交付

- 可直接查看：out/hyperframes/packaging-label-preview.mp4。
- 可复用透明原件：public/effects/packaging-label.webm。
- 效果元数据：public/effects/packaging-label.meta.json。
- 检查记录：out/hyperframes/validation.json。
- 五帧对照：out/hyperframes/packaging-label-contact.jpg。
- 可编辑项目：hyperframes/packaging-label/。
- 本地预览：http://127.0.0.1:3017/#project/packaging-label（验收期间保持运行）。

标签文字为 INDIVIDUALLY WRAPPED，使用本地 GSAP 3.15.0 和 Inter 700。样片采用原视频 8.78–10.78 秒，依照已审分镜缩进原片，标签上移至约 y=60。人声仅在该样片副本增加 10dB，尚未执行全片混音。样片不含最终字幕，也不是完整视频。

原件在 HyperFrames 中制作并真实渲染。FFmpeg 只用于原件解码检查与在原片上合成演示，没有代替 HyperFrames 生成效果。

## 下一步待确认

验收标签样片的大小、位置、出现速度和光泽强度后，再把已审字幕、六段画面和此效果接入 Remotion，制作整条动态初剪。数量卡片与包装信息的核对仍待处理。
