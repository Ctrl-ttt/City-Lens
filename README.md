# CityLens · 城市环境理解助手

React + TypeScript + FastAPI 原型：摄像头或本地 MP4 抽帧 → 千问视觉模型 → 校验与排序 → 大字提示及中文语音。支持环境提示、按键看牌、暂停、静音、重播及按键识别。

**当前状态：本地样例链路及自动测试可运行。真实模型、Link 2、真实路线素材、中文语音听感和用户评测仍待验收。** 样例模式不会识别实际画面，界面始终明确标记。没有测距、地图导航、红绿灯通行决策或全景 SDK 功能。

## Windows 快速启动

环境：Node.js 24、pnpm 11.19.0、Python 3.13 或 3.14、Microsoft Edge 或 Google Chrome。当前机器实测 Python 3.14.6；3.13 尚待另一台电脑验证。

在仓库根目录的 PowerShell 执行：

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1 -Sample
```

打开 **http://localhost:8000**。勾选样例说明后点击“开始识别”，由使用者允许摄像头访问。样例结果是固定的“右前方发现自行车”，并不代表镜头里真的有自行车。“看牌”返回带有“样例牌”前缀的固定文字。点击“测试中文语音”并实际确认声音；没有中文语音时页面显示仅文字状态。

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

仅在后端连接云端：JPEG 经清洗后发送，使用合成静音满足接口的音频前置要求，**不采集麦克风**。完整文字结果校验后才进入现有中文 TTS；每轮删除上游历史图像与回复，防止旧画面混入下一次观察。暂停、切换输入、页面隐藏会关闭实时会话；空闲连接也会自动关闭。实际费用以供应商账单为准，不能据此承诺零费用或供应商不留存数据。

实时仍是低频抽帧观察，不是逐帧视频理解或安全导航；约 1 秒是尝试采样间隔，不是响应时延保证。真实路线准确率、设备适配与中文播报听感仍需人工验收。

## 操作与设备

- 环境提示：HTTP 每 2 秒、实时连接每 1 秒尝试一帧，忙时跳过，不积压旧帧；每帧最多 3 个事件和 1 条播报，重复事件 8 秒内抑制。
- 看牌：停止自动观察并关闭实时连接，使用 HTTP 读取一次主要标牌；失败明确提示看不清，再点击“返回环境识别”。
- “只用按键识别”：每次点击分析一帧，用于网络延迟大或人工控制演示。
- 输入切换、视频拖动、暂停和页面进入后台会作废旧结果并清空语音；摄像头断开时显示错误。
- 视频：使用可解码的 H.264 MP4；播放结束可重新开始。自动识别会播放视频，按键/看牌会暂停视频并分析当前帧。
- Link 2：作为 USB 摄像头选择，关闭自动跟踪并固定朝向。当前方向表示非镜像画面的左右，并非用户真实朝向。
- 正式演示使用 localhost。服务仅监听本机，不面向公网或局域网。

## 开发与测试

```powershell
.\scripts\test.ps1
# 浏览器集成测试，先关闭占用 8000 端口的演示服务
.\scripts\test.ps1 -Browser
```

后端 pytest 使用模拟模型传输，前端 Vitest 覆盖会话与语音队列。Playwright 在 Windows 上优先使用已安装的 Edge，否则使用 Chrome；也可通过 `PLAYWRIGHT_CHANNEL` 覆盖。测试使用独立无头浏览器、模拟摄像头和真实本地样例 API，并生成合成 MP4 作为测试输入。测试不调用付费模型，不访问个人浏览器配置。运行 `pnpm --dir frontend test:e2e` 前需先构建前端。

开发前端可另开终端运行 `pnpm --dir frontend dev`，访问 http://localhost:5173，`/api` 代理到 8000。后端仍使用 `.venv` 启动。

目录：`frontend/` 前端；`backend/` API、视觉适配、排序和测试；`scripts/` Windows 安装/启动/测试；`docs/` 进度、接口、协作和验收；`local-data/` 为本地素材保留的忽略目录。

## 项目记录

- [文档中心与维护规则](docs/README.md)
- [产品需求文档（PRD）](docs/PRD.md)
- [架构与云端部署边界](docs/ARCHITECTURE.md)
- [最新进度与下一步](docs/PROGRESS.md)
- [API 契约](docs/API.md)
- [数据模型与数据治理](docs/DATA_MODEL.md)
- [测试设计与发布门槛](docs/TEST_STRATEGY.md)
- [ECS、OSS、RAM 与运行手册](docs/OPERATIONS.md)
- [架构决策记录](docs/DECISIONS.md)
- [四人分工与交付检查表](docs/TEAM.md)
- [访谈、评测与人工验收模板](docs/VALIDATION.md)

`frontend/pnpm-lock.yaml` 和 `backend/requirements.txt` 固定本次验证依赖。`backend/requirements.in` 用于有意更新依赖时重新解析，日常安装使用 `.txt`。
