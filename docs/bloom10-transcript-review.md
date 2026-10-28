# Bloom10 英语字幕：base / small.en 对照验收

当前有效素材：30.278 秒英语口播。状态：small.en 机器初稿，待听校，尚未锁定正式字幕。

## 素材与模型

- 源文件：public/recordings/Bloom10/Bloom10-达人素材.mp4
- SHA-256：31bf76ef1375c072f53117d2379660d40973ed323d61037d34afc3786a8274c3。
- 两版转录指纹一致，原视频未修改。
- small.en：487614201 字节，SHA-1 db8a495a91d927739e50b3fc1cc4c6b8f6c2d022，与官方 models/README.md 相符。
- CPU 完整识别工具报告约 35.24 秒，不代表其他素材的速度保证。

| 项目 | base | small.en |
| --- | --- | --- |
| 估计短时间单元 | 116 | 115 |
| SRT 字幕条数 | 14 | 14 |
| 低 token 概率提醒 | 24 | 11 |

提醒数量不能等同于错误数或准确率；两版都需要听校。small.en 已通过时间戳结构、SRT 数量和源文件指纹检查，尚未逐词确认声音同步。

## 重点差异

| 原视频大致时间 | base 机器结果 | small.en 机器结果 | 验收意见 |
| --- | --- | --- | --- |
| 1.25–2.70 秒 | viotic bruscomies | biotic breast gummies | 产品词更可读；包装可见 BIOTICS² / BREAST GUMMIES，品牌正式拼写仍需确认 |
| 14 秒附近 | fill the bottle away | go the bottle away | 两版都不自然；throw 仅是语义候选，尚未写回字幕 |
| 18 秒附近 | pretty good science container | pretty good size container | 新版本表达更合理，仍需听校 |
| 27–30 秒 | I'll hardly recommend these to you. | so I'll I'll highly recommend these to you. | 推荐含义发生重要变化；highly 是新模型结果，不代表已人工确认，重复 I'll 也需核对 |

为瓶子那句另做了带前后文的局部识别，但仍得到不稳定、不通顺的结果，没有据此自动修订主字幕。

## 听校音频

以下均是原视频音轨截取，仅在听校副本增加 10dB 音量；原音轨未改变。可结合原视频确认口型与上下文。

- out/review/bloom10/01-product-name.wav：原视频 0–3.3 秒。
- out/review/bloom10/02-bottle-phrase.wav：原视频 12.8–15.8 秒。
- out/review/bloom10/03-recommendation.wav：原视频 26.5–30.278 秒。
- out/review/bloom10/bottle-recheck.txt 和 .json：局部机器识别原始结果，含错误，不采用为正式字幕。

## 文件与历史版本

public/transcripts/Bloom10-达人素材.{txt,json,srt,review.json,meta.json} 现在对应 small.en 整段转录，保留原始识别措辞，没有按常识替换疑词。

- base 英语版归档：out/transcript-archive/Bloom10-english-base-20261027-113439/
- 西语旧素材版归档：out/transcript-archive/Bloom10-spanish-20261027-111721/
- 原始音频、日志及 JSON：当前 meta.json 的 runDirectory。
- 自动检查记录：out/review/bloom10/comparison-validation.json。

当前 SRT 仍为自动排句初稿，结尾 to you. 等短条需要在字幕编辑阶段重新排句。下一步建议听校确认品牌、瓶子那句和结尾措辞，再做字幕修订与画面分镜。尚未开始正式剪辑。
