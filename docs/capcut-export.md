# 剪映草稿导出

把 edit-plan 铺成**剪映专业版**草稿：切点、字幕、插画和画中画（位置、大小）、推近关键帧、音效都已摆好，在剪映里微调后再导出。

页面入口：**导出中心 → 剪映草稿**。命令行：

```powershell
npm run capcut:export -- <项目id> [--name="草稿名"] [--install]      # --install 同时放进剪映草稿箱
npm run capcut:check -- "projects/<id>/exports/capcut/<草稿名>"      # 结构检查（不需要打开剪映）
```

## 做了什么

| 方案里的东西 | 剪映草稿里 |
| --- | --- |
| 口播母带的每个片段（含片段缩放） | 「口播」轨，每段一个片段，缩放和位置按镜头原点换算；punch-in 是缩放关键帧 |
| `video-clip@1` 全屏插画 / 画中画 | 「插画」轨（重叠时自动分成多条），位置和大小换算成剪映的比例，`pushIn` 是缩放关键帧，静音 |
| `rect@1` 底色 | 「底色」轨，纯色图片 |
| 品牌图标 | 「品牌图标」轨 |
| 字幕 | 「字幕」轨，每个字幕块一个文本片段，字号、颜色、黑底、位置按字幕框换算 |
| 音效 | 「音效」轨：每个插画出现处一个 whoosh，品牌图标处一个 pop |

没带过去：字幕里单个词的强调色、`title-card` 以外的效果（`alpha-video`、`fade-through-black`）、响度标准化。导出时会列出未带过去的内容。

## 一次性安装（已做）

不动系统 Python：在项目里放了一份可移动的 Python 3.11.9。

```powershell
# 1. 下载 python-3.11.9-embed-amd64.zip（SHA-256 009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b），解压到 tools\python
# 2. tools\python\python311._pth 改成：
#      python311.zip
#      .
#      Lib\site-packages
#      import site
# 3. 安装 pip 和库（版本固定在 requirements-capcut.txt）
tools\python\python.exe get-pip.py
tools\python\python.exe -m pip install -r requirements-capcut.txt
```

`tools/` 已在 `.gitignore` 里，不会提交。库：pyJianYingDraft 0.3.1（Apache-2.0）。

## 兼容性说明

- 目标是本机的**剪映专业版 8.9**：它写出的 `draft_content.json` 是明文 JSON，生成的草稿顶层结构和版本字段（`version 360000`、`new_version 110.0.0`）与它自己写的草稿一致，`capcut:check` 会逐项比对。
- 我们**没有**在剪映里自动打开验证过：剪映有较新版本时库的作者只验证了"大部分功能可用"。第一次使用请先打开草稿看一遍；有问题改 `scripts/capcut/build_draft.py`。
- 国际版 CapCut 用另一套草稿格式（pyCapCut），这里没有做。
- 草稿里的素材是**路径引用**。不要移动 `public/` 下的文件。
- 放进剪映草稿箱的位置从剪映自己的 `root_meta_info.json` 读取（你的是 `F:\JianyingPro Drafts`）；已有同名草稿不会被覆盖。放进去后如果列表里没有，关闭再打开剪映。
