# CityLens · 城市环境理解助手

面向视障与低视力人群的环境理解原型。React + TypeScript + FastAPI 将摄像头或本地视频的抽帧发送给千问视觉模型，经过校验、排序和去重后，输出大字提示与中文语音。

## 分支用途

- **main**：程序代码、测试、安装启动脚本、设备工具与运行说明。
- **feat/realtime-vision**：完整开发现场，保留访谈、调研、工作报告、进度与比赛材料。见[开发分支文档](https://github.com/Ctrl-ttt/City-Lens/tree/feat/realtime-vision/docs)。

程序基线来自开发分支 `22eacc7`。本次整理不修改开发分支，过程材料不进入 main 当前文件树；既有提交历史保留。

## 当前功能与边界

| 能力 | 说明 |
|---|---|
| 环境提示 | 识别台阶、楼梯、行人、障碍与设施；当前标签不包含自行车，环境模式不读取标牌文字 |
| 按需看牌 | 按钮触发一次 HTTP 请求，读取主要标牌，看不清时明确反馈 |
| 全景视频 | 已拼接的 2:1 MP4 转为六向透视画面，打包一次模型请求 |
| 中文语音 | 暂停、重播、静音、重复抑制、播报阈值和详细度设置 |
| 延迟补偿 | 普通固定视角通过浏览器短期帧历史匹配更新识别框；不等于降低模型耗时或真实测速 |
| Skylight 食材插件 | 按键识别食材、可见新鲜度线索与挑选建议，不作为食品安全判断 |
| Link 2 设备工具 | USB 预览可用；仓库保留云台、变焦和对焦的后端接口及原生桥接，当前主页面未提供控制面板 |

X4 Air 当前通过录制、导出、导入视频参与识别，**没有接入 X4 Air 实时 SDK 取流**。方向相对校准后的相机。粗略远近和接近趋势不是精确测距、防碰撞或过街决策，不替代盲杖、导盲犬等专业辅助。

## Windows 快速启动

准备 Node.js 24、pnpm 11、Python 3.13（含 `py` 启动器）和 Edge／Chrome。按锁文件安装依赖，其他系统及 Python 版本需单独验证。

```powershell
git clone https://github.com/Ctrl-ttt/City-Lens.git
cd City-Lens
.\scripts\setup.ps1
.\scripts\start.ps1 -Sample
```

打开 **http://localhost:8000**。样例模式不分析真实画面、不调用云端模型。使用 `-Scene stairs`、`sign`、`empty` 或 `unclear` 切换固定样例。点击“测试中文语音”并确认声音；无中文语音时使用文字反馈。

如果 PowerShell 阻止脚本执行，可使用独立命令：

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend build
$env:CITYLENS_PROVIDER = 'sample'
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

按 Ctrl+C 停止。修改前端后用 `.\scripts\start.ps1 -Sample -Build` 重建。Python 下载受限时，安装脚本可加 `-Proxy` 并填写本机已有代理地址；脚本不修改系统或全局 Git 代理。

## 真实模型与食材插件

安装脚本仅在 `.env` 不存在时复制 `.env.example`。需要时手动复制，并在本机配置：

```dotenv
CITYLENS_PROVIDER=live
DASHSCOPE_API_KEY=在本机填写可用密钥
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3-vl-plus
```

停止样例后执行 `.\scripts\start.ps1`。`/api/health` 中 `configured=true` 只表示配置齐全，权限仍需真实图片请求验证。模型失败不自动回退样例。密钥只放后端，不提交 `.env`。

Skylight 默认复用上述配置，也可单独指定 `CITYLENS_SKYLIGHT_MODEL`。`CITYLENS_SKYLIGHT_ENABLED=false` 可关闭插件。插件超时 `CITYLENS_SKYLIGHT_TIMEOUT` 默认 22 秒，与环境模型预算分开。先暂停自动环境识别，再按食材按钮。

## 输入与操作

1. 选择摄像头或浏览器可解码的 H.264 MP4。
2. X4 Air 素材先用 Insta360 Studio 导出已拼接 **2:1 全景 MP4**，选择“360°全景”并校准正前方。原始 INSV 和双鱼眼文件不能直接当全景输入。
3. 了解并同意抽帧送云后开始识别。摄像头按当前实现镜像校正，视频保持原方向，现场需核对左右。
4. 看牌按钮暂停自动观察，处理后可切回环境模式。等待较长时使用按键识别。
5. 暂停、输入切换、拖动进度和页面隐藏会作废旧会话与待播内容。

环境播报阈值默认 70，候选须严格超过阈值。`low / medium / high` 详细度对应最多 `3 / 2 / 1` 项障碍，并逐级补充粗略远近和视觉接近趋势。默认重复冷却 4 秒，楼梯等连续目标 12 秒；配置见 `.env.example`。这些是提示规则，不是识别准确率。

### 可选实时通道

```powershell
.\scripts\start.ps1 -Realtime -Build
```

普通固定视角可用 WebSocket 连续帧通道，全景使用 HTTP。实时模型配置为 `DASHSCOPE_REALTIME_MODEL`，默认 `qwen3.5-omni-plus-realtime`，不替代 HTTP 模型。`DASHSCOPE_REALTIME_URL` 留空时从 HTTP 地址派生，也可填提供方的 `wss://` 地址。

“实时”指浏览器向后端发送连续帧，不是 X4 Air 实时取流或 30fps 云端理解。后端串行分析，只保留最新待分析帧；不采集麦克风，使用合成静音兼容协议。约 1fps 是采样频率，不是一秒响应保证。看牌仍走 HTTP。

### 设备与视频工具

普通 USB 画面输入不需要 SDK。开发 Link 2 控制接口时，安装 Visual Studio 2022 C++ 桌面开发与 CMake 工具，执行 `.\scripts\setup-link2.ps1`。桥接输出位于 `native/link2/build/Release/`。当前主页面没有设备控制面板，需另行接入接口；控制前暂停识别，确认画面稳定后手动恢复。

`tools/linkctl/` 与 `third_party/linksdk/` 保留独立设备工具及配套文件。`tools/x4_export.py` 调用另行安装的官方 Media SDK。`tools/x4_equirect_unofficial.py` 仅作非官方重投影预览，不具备设备标定、FlowState 防抖或官方拼接质量。用各工具的 `--help` 查看选项。

视频评测与非官方导出工具另需：

```powershell
.\.venv\Scripts\python.exe -m pip install -r scripts/video-requirements.txt
```

## 开发与测试

```powershell
.\scripts\test.ps1
# 先关闭占用 8000 端口的服务
.\scripts\test.ps1 -Browser
```

自动测试使用样例或模拟模型，不调用付费 API。导出工具测试需上述视频依赖。浏览器测试使用独立无头 Edge／Chrome，不访问个人浏览器配置。真实设备、识别质量、语音听感和现场延迟须另外验证。

当前完整浏览器验收尚未通过：Link 2 相关用例仍依赖主页面已不存在的控制面板；`app.spec.ts` 的限流冷却用例出现请求次数不符合预期；`realtime.spec.ts` 的字段断言尚未包含新增的两个播报配置字段，过期结果提示用例也未通过。全景与实时专项共 30 项，本机通过 27 项、失败 3 项。本次仅整理分支，保留开发分支程序与测试原貌，不把这些问题记为已解决。

开发界面：`pnpm --dir frontend dev`，访问 `http://localhost:5173`，API 代理到 8000；后端独立运行 Uvicorn。

| 目录 | 内容 |
|---|---|
| `frontend/` | 页面、输入、跟踪补偿、语音调度与测试 |
| `backend/` | API、模型、全景、排序、食材插件与测试 |
| `scripts/` | 安装、启动、测试、视频评测 |
| `native/`、`tools/`、`third_party/` | 设备桥接、视频工具和配套文件 |
| `docs/licenses/` | 第三方许可 |

主要 API：`GET /api/health`、`POST /api/analyze`、`WS /api/realtime`、`POST /api/plugins/skylight/analyze`。HTTP 分析以 multipart 上传 JPEG（上限 2 MB），必填 `image`、`mode`、`source`、`session_id`、`frame_id`；可选 `projection`、`heading_deg`、`speech_threshold`、`speech_detail_level`。类型定义见 `backend/models.py`，响应约定与示例见 `backend/tests/test_api.py`。

## 数据与许可

用户同意后抽帧送云，本地视频不整段上传。应用默认不保存输入帧、原视频或 OCR 全文，临时图像与会话状态在内存中处理；模型供应商数据政策另行核实。`local-data/`、`work/`、环境文件与原始视频已加入忽略规则。

全景透视依赖 py360convert，随附[MIT 许可](docs/licenses/py360convert-MIT.txt)。其他组件遵循各自许可，本次整理不替第三方 SDK 或项目新增授权声明。
