# VideoAutomation

竖屏短视频 Remotion 工程。当前阶段：基础工程与环境测试，尚未加入正式素材。

## 启动预览

在 PowerShell 中执行：

```powershell
Set-Location F:\VideoAutomation
npm.cmd run dev
```

浏览器地址以终端输出为准。在 Studio 中选择 `Reel`，点击播放查看动画；按 Ctrl+C 停止开发服务。

## 测试画面

- Composition：`Reel`
- 尺寸：1080 × 1920
- 帧率：30fps
- 时长：90 帧（3 秒）
- 内容：中文环境测试、淡入文字、进度条。颜色仅用于环境验证，品牌样式尚未确认。

## 验证与构建

```powershell
npm.cmd run lint
npm.cmd run build
```

生成环境测试视频：

```powershell
npx.cmd remotion render src/index.ts Reel out/setup-test.mp4 --browser-executable="C:\Program Files\Google\Chrome\Application\chrome.exe" --concurrency=2
```

## 目录用途

| 目录 | 用途 |
| --- | --- |
| src | Remotion 画面组件与视频规格 |
| public/recordings | 口播和主要拍摄素材 |
| public/screen-recordings | 屏幕录制素材 |
| public/images | 图片素材 |
| public/sound pack | 音效 |
| public/music pack | 背景音乐 |
| public/transcripts | 转录及字幕时间数据 |
| hyperframes | 后续独立特效项目 |
| brand | 后续品牌配置 |
| scripts | 后续转录和检查脚本 |
| bin | 后续本地工具 |
| out | 导出的测试画面和视频 |

安装依赖可运行 `npm.cmd ci`。保留 package-lock.json，以便复现依赖版本。
Remotion 官方文档：https://www.remotion.dev/docs/

## 当前验证记录（2026-10-27）

- ESLint 与 TypeScript 检查通过，Remotion bundle 构建通过。
- 使用已安装的 Chrome 完成 Reel 的 H.264 渲染；FFprobe 确认 1080×1920、30fps、90 帧、3 秒。
- 本地 Studio 的 /Reel 页面 HTTP 检查返回 200；导出样帧已检查中文显示。
- 模板 Remotion 版本为 4.0.539。其固定的 Zod 4.5.4 被 npm audit 标记受影响，因此 package.json 使用 overrides 将 Zod 固定为 4.6.7，当前 npm audit 为 0 告警。
- 此调整会触发 Remotion 的 Zod 版本不匹配提示。调整后的 lint、构建与完整测试视频渲染均通过；未来使用 Zod schema 相关功能时仍需验证兼容性。
- 创建工具已初始化 Git 并暂存文件，但首次提交未成功；本阶段未修改用户的 Git 身份配置。
