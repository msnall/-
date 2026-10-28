# 本地 Whisper 转录环境

本阶段只搭建和验证底层识别工具；视频转录封装脚本和中文素材验收留到下一步。

## 版本和路径

- 源码：https://github.com/ggml-org/whisper.cpp
- 固定源码提交：231638a0717b7822784297e5980965ffcec05810
- 编译版本：1.9.5-dev
- 编译方式：MSVC 2022，x64 Release，CPU / AVX2，4 个并行编译任务。
- 程序：bin/whisper.cpp/build/bin/Release/whisper-cli.exe
- 多语言模型：bin/whisper.cpp/models/ggml-base.bin
- 模型预期大小：147951465 字节。
- 官方 models/README.md 中的 SHA-1：465707469ff3a37a2b9b8d8f89f2f99de7299dac。
- SHA-256：60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe。

## 重新编译

在 F:\VideoAutomation 的 PowerShell 中执行：

```powershell
git -c http.version=HTTP/1.1 clone --depth 1 https://github.com/ggml-org/whisper.cpp.git bin/whisper.cpp
# 若将来远端 main 已更新，需要先取得并检出上述固定提交。
cmake -S bin/whisper.cpp -B bin/whisper.cpp/build -G "Visual Studio 17 2022" -A x64 -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DGGML_CUDA=OFF -DGGML_VULKAN=OFF
cmake --build bin/whisper.cpp/build --config Release --target whisper-cli --parallel 4
```

请保留 Release 目录内的 DLL 文件，不能只移动 exe。

## 模型下载

官方地址：
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

本机直连官方地址超时、HF 镜像速度较慢，改用以下 ModelScope 镜像下载，并在使用前比对官方 SHA-1：
https://www.modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-base.bin

```powershell
Get-FileHash bin/whisper.cpp/models/ggml-base.bin -Algorithm SHA1
```

base 是多语言模型；base.en 为英语专用模型。中文素材使用 -l zh，不使用翻译到英语的 -tr 参数。

## 官方示例转录

```powershell
& .\bin\whisper.cpp\build\bin\Release\whisper-cli.exe -m .\bin\whisper.cpp\models\ggml-base.bin -f .\bin\whisper.cpp\samples\jfk.wav -l en -ng -t 4 -ml 1 -sow -ojf -otxt -osrt -of .\out\whisper-smoke
```

原始 JSON、TXT 和 SRT 输出位于 out/。英文样本仅验证识别链路；中文识别准确率和实际字幕对齐，需要另用正式素材验收。细粒度 token 时间不是人工标注或强制对齐的保证。

源码、编译产物和模型保存在忽略的 bin/whisper.cpp/ 下，不纳入主项目 Git。第一次失败的克隆被保留在忽略的 out/whisper-incomplete-clone/，以便排查。

## 验证结果（2026-10-27）

- MSVC Release 编译通过；whisper-cli --version 返回 1.9.5-dev。
- 模型文件 147951465 字节；SHA-1 和 SHA-256 均与记录值一致。
- 官方 11 秒 jfk.wav 完成 CPU 转录，工具报告总耗时约 4.64 秒（非性能保证）。
- 已输出 out/whisper-smoke.json、out/whisper-smoke.txt、out/whisper-smoke.srt。
- 已自动检查所有非空片段时间戳为有效数字、顺序正确、结束不早于开始，并位于音频时长内。
- out/whisper-validation.json 记录识别文字和验证范围。尚未验证用户中文素材，也尚未创建 scripts/transcribe.mjs。

## 英语专用 small.en 模型

已下载到 bin/whisper.cpp/models/ggml-small.en.bin，大小 487614201 字节。

- 下载镜像：https://www.modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/ggml-small.en.bin
- 与官方 models/README.md 一致的 SHA-1：db8a495a91d927739e50b3fc1cc4c6b8f6c2d022。
- 实际 SHA-256：c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d。
- 模型完整性校验已通过；此模型只用于英语。

显式选择该模型运行：

```powershell
npm.cmd run transcribe -- "public/recordings/Bloom10/Bloom10-达人素材.mp4" --language en --model "bin/whisper.cpp/models/ggml-small.en.bin" --force
```

--force 会替换 public/transcripts/ 下的同名结果；运行前应保留需要比较的版本。每次原始识别运行仍独立保存在 out/transcriptions/。
