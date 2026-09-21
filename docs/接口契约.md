# API 契约 v0.1

> 实现事实来源：`backend/models.py`、`backend/app.py` 和契约测试。字段语义与保留策略见 [DATA_MODEL.md](DATA_MODEL.md)，架构边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。
>
> 当前契约适用于本地可信来源。ECS 公网部署前，必须把可信主机和允许来源改为受环境配置控制，并为正式 HTTPS 域名补充测试；不得通过放开任意来源来绕过部署限制。

服务：localhost:8000。模型适配在同一 Python 服务中；无数据库，不保存输入帧。响应包括 `Cache-Control: no-store`（识别接口）。

## GET /api/health

```json
{"status":"ok","provider":"sample","configured":true,"model":"fixed-sample","sample_scene":"bicycle","version":"0.1.0"}
```

`configured` 只检查配置存在，不发模型请求；live 时 `sample_scene=null`。不返回密钥。

## POST /api/analyze

multipart/form-data，必须且仅包含以下五个字段（不能重复）：

| 字段 | 要求 |
|---|---|
| image | JPEG 文件、image/jpeg、最大 2 MiB；图片必须可解码，最多 1200 万像素 |
| mode | walk / read |
| source | camera / video |
| session_id | 1–80 字符，仅字母、数字、下划线、短横线 |
| frame_id | 0 到 2147483647 的整数 |

```json
{
  "session_id":"demo-001","frame_id":1,"status":"ok",
  "events":[{"category":"obstacle","label":"bicycle","direction":"right","text":"自行车"}],
  "speech":{"key":"bicycle:right","priority":"high","text":"右前方发现自行车"},
  "latency_ms":1800,"error_code":null,"message":null
}
```

类别 `obstacle/facility/text`；方向 `left/front/right/unknown`；状态 `ok/uncertain/error`。
无事件时 `events=[]`、`speech=null`，不输出通行结论。看牌不清晰时 `status=uncertain`，候选文字为“文字看不清，请调整拍摄角度”。优先级由服务代码决定。

受控错误返回相同响应外壳、空事件、无播报、`error_code` 和中文 `message`。解析到元数据前的错误可能返回空 session_id 和 frame_id=0。

| 状况 | HTTP / error_code |
|---|---|
| 无配置 | 200 / not_configured |
| 模型认证失败、限流或暂不可用 | 200 / model_auth、rate_limited、model_unavailable |
| 超时、网络或格式错误 | 200 / model_timeout、network_error、invalid_model_output |
| 请求字段或图片无效 | 422 / invalid_input |
| 图片/总请求超限 | 413 / image_too_large |
| 上次模型请求未完成 | 429 / busy |
| 不在允许列表的网页来源 | 403 / forbidden_origin |
| 服务内部异常 | 500 / internal_error |

前端须同时检查 HTTP 状态和业务 `status`，不得朗读原始错误。walk 超过 6 秒、read 超过 8 秒的结果作废。切换输入、暂停、拖动、模式变化生成新 session_id；返回结果必须匹配 session_id 和 frame_id。后端全局最多一个模型请求，切换会话后的短暂 busy 属于正常拒绝排队行为。

事件排序：台阶/楼梯 → 其它障碍物 → 设施；环境模式过滤标牌，看牌模式过滤其它类别。去重后最多保留 3 项。模型端总超时 8 秒，不自动重试旧帧。

## 兼容性与变更规则

- `v0.1` 中字段均为受控字段，客户端不得依赖未文档化的额外字段或模型原始响应。
- 新增标签、类别、方向、必填字段、错误码或请求方式时，必须同时更新 Pydantic 模型、前端类型、规则、本文档和测试。
- 删除或改变既有字段语义属于破坏性变更；必须提高接口小版本，提供迁移说明，并在旧版本客户端完成迁移前保留兼容路径。
- `distance`、经纬度、用户身份、路线指令和“是否安全通行”等字段不属于本接口。相关需求应先通过 ADR、安全评估和独立测试后再讨论。
