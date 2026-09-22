# CityLens · 城市环境理解助手

React + TypeScript + FastAPI 原型：摄像头或本地 MP4 抽帧 → 千问视觉模型 → 校验与排序 → 大字提示及中文语音。支持环境提示、按键看牌、暂停、静音、重播及按键识别。

**当前状态：支持已拼接2:1全景MP4的六方向识别、综合优先级和每次最多两项播报。用户补充的全景MP4已完成路线抽帧、前向校准和真实网页中文语音链路测试；明确后方接近的实景验证、语音听感及用户评测仍待验收。** 见[全景选择性播报与实测记录](docs/全景选择性播报.md)。样例模式明确标记，不识别实际画面；没有精确测距、通行判断或X4 Air实时SDK取流。

## Windows 快速启动

环境：Node.js 24、pnpm 11.19.0、Python 3.13 或 3.14、Microsoft Edge 或 Google Chrome。本次全景模块使用 Python 3.13 验证；另一台电脑及其它Python版本仍需复现。

在仓库根目录的 PowerShell 执行：

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1 -Sample
```

打开 **http://localhost:8000**。勾选样例说明后点击“开始识别”，由使用者允许摄像头访问。样例结果是固定的“右侧发现自行车”，并不代表镜头里真的有自行车。“看牌”返回带有“样例牌”前缀的固定文字。点击“测试中文语音”并实际确认声音；没有中文语音时页面显示仅文字状态。

首次安装遇到网络问题，可为 Python 安装命令传入电脑已经配置的代理，例如：

```powershell
.\scripts\setup.ps1 -Proxy http://127.0.0.1:10808
```

代理端口需与本机配置一致；脚本不修改系统或全局 Git 配置。PowerShell 若提示脚本策略限制，可按下面的独立命令启动，不需要调整系统策略：

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend build
$env:CITYLENS_PROVIDER = 'sample'
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

服务在终端前台运行，按 Ctrl+C 停止。再次启动不需要重复安装；修改前端后使用 `start.ps1 -Sample -Build`。切换样例场景可加 `-Scene stairs`、`sign`、`empty` 或 `unclear`。

## 接入真实模型

安装脚本只在 `.env` 不存在时复制 `.env.example`，不会覆盖已有配置。在本机编辑 `.env`：

```dotenv
CITYLENS_PROVIDER=live
DASHSCOPE_API_KEY=在本机填写赛事账号密钥
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3-vl-plus
```

停止样例服务后运行 `.\scripts\start.ps1`（不加 `-Sample`）。该脚本明确选择 live，避免因旧环境变量误用样例。检查 `/api/health` 的 `provider=live`、`configured=true`；这仅说明配置齐全，**不证明密钥权限有效**，还需要一次获授权图片的真实请求。模型失败不会自动回退样例；模型名、地址以实际赛事权限为准。

API Key 只放后端，不能填入前端代码或提交仓库。不把密钥发到聊天、访谈或演示材料里。真实模式需用户在页面同意后才上传抽帧；本地 MP4 不整段上传。应用不将输入帧、原始视频或 OCR 全文写入日志；本次会话的结果暂存在内存。模型供应商的数据政策需要单独核实。

## 实时视觉预览

更新依赖并启动（保留已有 `.env` 密钥和 HTTP 模型配置）：

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
.\scripts\start.ps1 -Realtime -Build
```

打开 http://localhost:8000，同意抽帧处理后选择摄像头或 MP4。页面可手动切换“实时连接”和“HTTP 抽帧”；切换后需重新开始，失败不会偷偷回退到样例。

实时模型默认 `qwen3.5-omni-plus-realtime`，可通过 `DASHSCOPE_REALTIME_MODEL` 修改；`DASHSCOPE_REALTIME_URL` 留空时沿用 HTTP 地址的主机，路径改为 `/api-ws/v1/realtime`，也可填供应商提供的完整 `wss://` 地址（不含查询参数）。HTTP 仍使用 `DASHSCOPE_MODEL`，不要把它改成 `-realtime` 模型。

**“实时连续帧流”仅指浏览器 → 后端 WebSocket，不是云端双工输入或 30fps 视频理解。** 自动观察在后端 `ready` 后约 1fps 持续发送，不等待上一帧结果；客户端背压时不 capture、不排队，最多保留 16 条无图片的帧元数据。后端 `receive_frames` 持续校验/清洗并用 `Queue(maxsize=1)` 替换旧待分析图，`process_frames` 取最新图串行调用 `RealtimeVision.observe(image)`：应用分析状态最多一张分析中 + 一张最新待分析，生成及删除确认期间不向云端发送新图。就绪后的接收不会因自身生成而 `busy`；与 HTTP 竞争模型锁才会 `busy`。

**先前云端重叠输入方案已被真实 API 证伪。** [官方 Python SDK 手动时序](https://www.alibabacloud.com/help/en/model-studio/omni-realtime-python-sdk)要求 `turn_detection=null` 时在生成期间停止音视频输入；实测在 `response.created` 后送图、`response.done` 后再 commit 会失败 `buffer too small`，VAD 也会丢弃纯静音，不能在不采集麦克风的前提下直接改 VAD 解决。当前仅后端连接云端，保持合成 PCM 静音（200ms 前导 + 每图 1s 尾音）、**无麦克风**，按“上传一张 → 生成 → 清理并等确认 → 取最新图”运行。尾音及 `conversation.item.delete`/ack 是当前模型兼容实测，不承诺供应商长期稳定、历史绝不影响结果或供应商不留存数据；完整文字校验后才进入中文 TTS。

`result.frame_id` 是实际选中分析的帧，可返回 1、3 而跳过 2，不是多图 commit 的最新边界。`latency_ms` 从该帧后端接收起算；前端按该帧 capture 时间执行自动观察 6s / HTTP 看牌 8s 过期，不重传旧图。实时帧是纯 base64 JPEG（编码后 ≤256KiB），后端清洗最长边 960；客户端发送间隔 ≥1s，服务端限制 ≥0.9s。

后端单轮 generation 的上传、响应、清理确认整体限时 8s；前端等待 `ready` 最多 15s，有待返回帧但 9s 无有效新结果进展即断开。可重试错误按 1/2/4s 最多重连 3 次，`ready`/`result` 不重置预算；恢复后只采新图。后端等待下一帧 30s 空闲关闭，会话限 110min。暂停、切换输入、页面隐藏及 Link 2 控制会关闭实时会话并作废旧结果。约 1 秒是采样间隔，不是响应时延保证，更不是安全导航；实际费用以供应商账单为准。

## 操作与设备

- 环境提示：HTTP 与实时连接的 `walk` 都自动包含可读路牌、门牌和方向指示牌。HTTP 每 2 秒尝试一帧且 single-flight，忙时跳过；实时自动观察在 ready 后每 1 秒持续向后端发新帧，不等结果，后端仅保留最新待分析槽；每帧最多显示 3 个事件。
- 标牌清晰度：`high` 为大字、干净且完整清楚可读；`medium` 为较小但所选文字仍完整可读；`low` 为模糊、缺字或不确定，服务端排除其事件与播报。这是模型的视觉定性判断，不是距离或经校准的准确率。
- 排序与播报：台阶/楼梯 → 其它障碍 → high 标牌 → medium 标牌 → 设施，同级保留原顺序；标牌按规范化空白后的相同文字去重，不区分方向或清晰度。每帧仅首项可生成播报：障碍 high 可打断、标牌 normal、设施 low。自动播报仍受 8 秒去重限制，手动触发绕过去重；重复首项障碍被抑制时，不改播同帧标牌，标牌可能等后续帧才被选中。
- 看牌：停止自动观察并关闭实时连接，仍用较高分辨率的单次 HTTP 请求，只读取最清晰的一块标牌（最多 1 项，不含障碍或设施）；失败明确提示看不清，再点击“返回环境识别”。
- “只用按键识别”：每次点击分析一帧，用于网络延迟大或人工控制演示。
- 输入切换、视频拖动、暂停和页面进入后台会作废旧结果并清空语音；摄像头断开时显示错误。
- 视频：使用可解码的 H.264 MP4；播放结束可重新开始。自动识别会播放视频，按键/看牌会暂停视频并分析当前帧。
- 摄像头镜像校正：预览、实时送帧和 HTTP 抽帧（含手动看牌）同步水平翻转，使预览与模型输入一致；本地视频回放保持原方向。这用于当前镜像摄像头输入，不代表所有摄像头都需要翻转，也不保证 OCR 准确率。
- Link 2：浏览器采集 USB 画面，官方 SDK 提供本地云台、变焦及自动对焦控制。请在 Link Controller 中关闭自动跟踪、固定朝向，再关闭 Controller，避免争用设备；本应用不会自动修改跟踪模式。当前方向表示校正后画面的左右，并非用户真实朝向。
- 正式演示使用 localhost。服务仅监听本机，不面向公网或局域网。

### Link 2 SDK（Windows x64）

先安装 Visual Studio 2022 的“使用 C++ 的桌面开发”和 C++ CMake 工具，再执行：

```powershell
.\scripts\setup-link2.ps1
.\scripts\start.ps1 -Sample -Build
```

安装脚本将官方 SDK 固定到指定版本，编译 `native/link2/build/Release/citylens-link2.exe` 并复制 `UVCCamera.dll`；不需要修改 `.env` 或提供相机密钥。网络受限时可给安装脚本传入 `-Proxy`。SDK 源码和构建产物不提交到仓库。

连接一台 Link 2，在摄像头列表选择设备，点击“仅本地预览”，再展开“Link 2 相机控制”。本地预览和相机控制不上传画面，也不需要勾选云端分析同意。可刷新状态、设置水平 −145～145 度/俯仰 −45～90 度、回正、按设备范围变焦及切换自动对焦。

控制前会暂停识别、关闭实时连接并清除旧提示；指令进行中不能重新识别，成功只代表设备接收了指令，不代表云台已到位。确认画面稳定后刷新状态，再手动开始识别。未安装 SDK 时仍可使用 USB 预览和识别；未预览、设备不匹配或多台 Link 2 时不开放控制。Link、Link 2C、Link 2 Pro 不在本次控制范围内。

当前已完成本地编译、无设备枚举和一台真实 Link 2 的枚举/状态读取验证；浏览器控制流程使用模拟设备回归。真实画面与控制并行、角度方向、变焦和对焦效果仍需人工验收。

## 开发与测试

```powershell
.\scripts\test.ps1
# 浏览器集成测试，先关闭占用 8000 端口的演示服务
.\scripts\test.ps1 -Browser
```

后端 pytest 使用模拟模型传输，前端 Vitest 覆盖会话与语音队列。Playwright 在 Windows 上优先使用已安装的 Edge，否则使用 Chrome；也可通过 `PLAYWRIGHT_CHANNEL` 覆盖。测试使用独立无头浏览器、模拟摄像头和真实本地样例 API，并生成合成 MP4 作为测试输入。测试不调用付费模型，不访问个人浏览器配置。运行 `pnpm --dir frontend test:e2e` 前需先构建前端。

2026-09-22 最新槽调度工作区已通过后端 452 项、前端单测 57 项、浏览器 E2E 48 项、原生桥接 1 项及生产构建，版本和实际命令见[本轮执行记录](docs/测试策略与发布门槛.md#34-本轮执行记录2026-09-22)。另用自制标牌/空白图及合成摄像头完成真实实时模型调用、跳帧归属和页面暂停验证；这些结果不证明真实摄像头 OCR 准确率。真实摄像头、现场文字与中文播报听感仍待实际验收，不能用模拟上游的重叠输入测试宣称云端重叠已验证成功。

开发前端可另开终端运行 `pnpm --dir frontend dev`，访问 http://localhost:5173，`/api` 代理到 8000。后端仍使用 `.venv` 启动。

目录：`frontend/` 前端；`backend/` API、视觉适配、排序和测试；`scripts/` Windows 安装/启动/测试；`docs/` 进度、接口、协作和验收；`local-data/` 为本地素材保留的忽略目录。

## 项目记录

- [组队提案书](docs/组队提案书.md)
- [文档中心与维护规则](docs/文档中心.md)
- [产品需求文档（PRD）](docs/产品需求文档.md)
- [架构与云端部署边界](docs/架构与云端边界.md)
- [最新进度与下一步](docs/项目进度.md)
- [API 契约](docs/接口契约.md)
- [数据模型与数据治理](docs/数据模型与数据治理.md)
- [测试设计与发布门槛](docs/测试策略与发布门槛.md)
- [ECS、OSS、RAM 与运行手册](docs/运维手册.md)
- [架构决策记录](docs/架构决策记录.md)
- [四人分工与交付检查表](docs/团队分工与交付检查表.md)
- [访谈提纲](docs/访谈提纲.md)
- [访谈、评测与人工验收模板](docs/验收记录.md)

`frontend/pnpm-lock.yaml` 和 `backend/requirements.txt` 固定本次验证依赖。`backend/requirements.in` 用于有意更新依赖时重新解析，日常安装使用 `.txt`。
