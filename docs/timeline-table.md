# 表格方案与时间线文件

「③ 方案」页每个版本是一张表：**时间 | 口播内容 | 画面 | 效果 | 字幕 | 音效**，一行一句口播。整套选，或者逐行改。

## 一份时间线文件

表格不另存数据。每个版本只有一个文件：`projects/<id>/cut-script.<版本>.json`（版本：`full` 全屏插画、`minimal` 极简口播、`pip` 按风格卡）。表格读它、改它；保存时写回它，再重新编译出 `edit-plan.draft.<版本>.json`。放进审阅精修时，才由 draft 变成审阅台里的新版本，再渲染。

## 一行（beat）里有什么

```jsonc
{ "id": "b04", "text": "Now I use crazy fonts, …",
  "voice": { "asset": "c1-waist-a", "startMs": 9300, "endMs": 13200, "ranges": [[9300, 13200]],   // 清理后保留的口播片段
             "wordStart": 20, "wordEnd": 31, "droppedWords": [] },
  "broll": [{ "asset": "screen-m1", "srcStartMs": 300, "atMs": 700, "durationMs": 1800, "layout": "full|pip", "slot": "top-right" }],   // 画面
  "zoom": 1.2,          // 效果：推近倍数；省略 = 自动（近景和中景交替）；1 = 不推近
  "sfx": "auto|none|whoosh|pop" }   // 音效；省略 = auto
```
顶层还有 `emphasis: [{ beat, word }]`（字幕里高亮的词）和 `logo`（常驻品牌图标从哪句哪一刻开始）。

## 保存前检查

镜头必须在这一句之内、两个镜头不能重叠、时长 0.4–6 秒、素材起点加时长不能超过素材本身、画中画要选位置、推近 1–1.5、一句最多高亮 3 个词、高亮的词必须在这一句里。有问题整次不保存，并逐条说明。

## 音效

音效列表写在 edit-plan 的 `meta.sfx`（`[{ atFrame, kind }]`）。网页渲染的成片**不含音效**，只在导出剪映草稿时铺成「音效」轨；音是自制的合成音，可以在剪映里换。
