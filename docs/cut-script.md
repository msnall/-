# 剪辑脚本 cut-script（schemaVersion 1）

素材 + 脚本 → **剪辑脚本** → edit-plan。剪辑脚本是给人审阅的中间层：每一行脚本用哪段口播、配什么画面、涉及哪些产品事实。文件：`projects/<id>/cut-script.<scriptId>.json`。

## 流程（阶段一）

```powershell
npm run order:ingest -- "<订单目录>" <项目id>        # 素材入库：转正、<=1080 宽、30fps 工作副本，写 ingest.json
npm run order:transcribe -- <项目id>                  # 达人片转录（small.en），无人声的片标 speech:false
npm run order:align -- <项目id> [--candidate=cand-b]  # 脚本行对齐转录，写 analysis/alignment.json
npm run cut:build -- <项目id> [--candidate=cand-b]    # 生成剪辑脚本草稿
npm run cut:check -- <项目id> [--file=cut-script.cand-b.json]
```

订单目录只读；工作副本在 `public/derived/<id>/`。

## 结构

- `beats[]`：每条脚本行一个 beat。`status`：`ready`（对齐分 ≥0.85）、`needs-review`（0.6–0.85，看 `voice.heard`）、`missing-footage`（没有对应口播，要补拍）。
- `voice`：`asset`、`startMs/endMs`（原片毫秒，在词间静音中点下刀）、`score`、`heard`（实际听到的词）、`pausesMs`（超过 220ms 的停顿，供去停顿）、`alternates`（其他 take）。
- `visuals[]`：按时间顺序铺满该 beat 的镜头。`kind`：`talk`（达人画面）/ `screen`（录屏，`srcStartMs`、`durationMs`）/ `action`（达人动作）/ `logo`。默认一个全程 `talk`；录屏插画由审阅时加入，`suggest` 给出按标签匹配的候选。
- `claims[]`：该行涉及的产品事实，必须出自 `brief.product.claimsAllowed`。

## 校验（cut:check）

错误：未知素材、时间越界、口播素材无人声、声明了不在 claimsAllowed 的事实、文字命中禁止项（虚构数字、评分/奖项/最高级、电池/隐私/安全、竞品对比）。警告：缺口播、低分对齐、素材分辨率不足、总口播超 60 秒。

## 状态

`draft` → 人工改过后改为 `reviewed`；`cut:build` 不会覆盖非 draft 的文件。下一阶段由编译器把 reviewed 的剪辑脚本转成多素材 edit-plan。

---

# v2：以达人口播为准（当前流程）

达人交回的视频和预设脚本对不上时，不再对齐脚本，而是**以达人实际说的话为准**。v1（对齐脚本、`cut-script.<方案>.json`）保留但不再使用。

## 流程

```powershell
npm run order:ingest -- "<订单目录>" <id>      # 入库
npm run order:transcribe -- <id>                # 转录
# 打开素材分类页（npm run desk → 素材分类），校对「文案」并确认
npm run order:sync-text -- <id>                 # 校对后的文字写回 public/transcripts/<片>.edited.json（词数必须与转录一致，时间不变）
npm run cut:seed -- <id> "--split=<片>:<词序号>,<词序号>"   # 生成 cut-script.json：每行文案一个 beat，切点吸附到最安静的 10ms，再吸附到 30fps 帧
# 在 cut-script.json 里给每个 beat 写 broll（录屏插画）和 emphasis（字幕强调词）
npm run cut:compile -- <id>                     # 声音母带 + 母带转录 + edit-plan.json（r0）
npm run plan:check -- projects/<id>/edit-plan.json
npm run plan:render -- projects/<id>/edit-plan.json out/<id>/<名字>.mp4
```

## cut-script.json（schemaVersion 2）

- `beats[]`：`id`、`text`、`voice {asset, startMs, endMs, wordStart, wordEnd}`（原片毫秒）、`broll[]`。
- `broll[]`：`{ id, asset, srcStartMs, atMs, durationMs, layout, note }`。`atMs` 是 beat 内偏移，`srcStartMs` 是录屏素材内的起点。录屏静音，达人的声音一直在下面播放。
- `emphasis[]`：`{ beat, word, color? }`，字幕里要强调的词。
- 编译规则：竖屏且宽 ≥1080 的素材铺满画面；更小的素材按原尺寸放在深色底上，不放大，避免模糊（品牌禁止模糊/像素化画面）。

## 编译产物

- `public/derived/<id>/voice-master.mp4`：把所有 beat 的口播按顺序接成的母带（画面+声音）。
- `public/transcripts/<id>-master.json` / `.cues.json`：母带时间轴上的校对词和字幕块（每块 ≤5 词，不跨 beat）。
- `projects/<id>/edit-plan.json`：每个 beat 一段 segment；录屏是 `video-clip@1`（新增效果）覆盖层，用 `{segment, offsetMs}` 锚点；字幕全大写。

编译只负责生成 r0，不渲染。之后修改一律走审阅台的提案。
