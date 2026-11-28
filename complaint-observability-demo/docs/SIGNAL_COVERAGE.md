# 投诉处理 Demo 信号覆盖与全量查询

本文以当前分层 PSOP 的四 JVM 运行方式为准。先启动本地存储并执行一次带遥测的成功案例：

```powershell
.\scripts\start.ps1
.\scripts\run-four-jvm.ps1 -Case success -RunId signal-check-001 -EnableTelemetry
.\scripts\verify-storage.ps1 -Case success -RunId signal-check-001 -ServiceName complaint-waimo
```

`success` 用于查看完整正常链路；`authorization-denied` 用于查看授权拒绝、workflow failed 和 step failed 的信号。

## 当前已覆盖的信号

### Trace

| 信号 | 当前产生位置 | 成功案例中的情况 |
| --- | --- | --- |
| `a2at.workflow` | WAIMO 与 Transport 各自执行 workflow | 两个 workflow 位于同一 Trace 中 |
| `a2at.step.<step>` | Workflow Engine 执行的每个实际步骤 | WAIMO 6 个步骤，Transport 10 个实际步骤 |
| `SendMessage` CLIENT / SERVER | WAIMO → Transport、Transport → OMC、OMC 内部任务调用 | 带 `task-t`、任务、步骤、`context_id` 等属性 |

WAIMO 发往 Transport、Transport 发往 OMC 的 HTTP 请求都传递 `traceparent`。因此可在 Jaeger 的同一个 Trace 里展开 workflow、step 和 A2A span 的父子关系。

### Metric

本表按最新 SDK 的维度定义整理；短生命周期 Demo 的指标由 Collector 汇聚，计数值按进程和时间序列观察，不应当作单个 run 的唯一标识。

下表的“Prometheus 名称”是实际查询名。Histogram 会额外生成 `_bucket`、`_count`、`_sum` 三条时间序列。

| 逻辑指标 | Prometheus 名称 | 覆盖情况 | 主要维度 |
| --- | --- | --- | --- |
| workflow 次数 | `gen_ai_agent_a2at_workflow_count_total` | WAIMO、Transport 的成功和失败工作流 | `workflow_type`、`workflow_status`、`service_name` |
| workflow 耗时 | `gen_ai_agent_a2at_workflow_duration_milliseconds_{bucket,count,sum}` | 同上 | `workflow_type`、`workflow_status`、`service_name` |
| step 耗时 | `gen_ai_agent_a2at_step_duration_milliseconds_{bucket,count,sum}` | 所有实际执行的 PSOP step | `gen_ai_agent_a2at_workflow_step_status`、`gen_ai_agent_name`、`service_name` |
| step 次数 | `gen_ai_agent_a2at_step_count_total` | 每个实际执行的 PSOP step | `workflow_step_status`、`gen_ai_agent_name`、`service_name` |
| substep 次数 | `gen_ai_agent_a2at_substep_count_total` | Agent 实际执行的子步骤 | `substep_status`、`gen_ai_agent_name`、`service_name` |
| Task-T 次数 | `gen_ai_agent_a2at_task_count_total` | 工作流任务与区域诊断/修复子任务 | `task_type`、`task_object`、`task_status`、`service_name` |
| Task-T 耗时 | `gen_ai_agent_a2at_task_duration_milliseconds_{bucket,count,sum}` | 同上 | `task_type`、`task_object`、`task_status`、`service_name` |
| Agent 子步骤耗时 | `gen_ai_agent_a2at_substep_duration_milliseconds_{bucket,count,sum}` | 每一次 MockAgent 任务 | `gen_ai_agent_name`、`gen_ai_agent_a2at_substep_status`、`service_name` |
| A2A 客户端调用耗时 | `gen_ai_client_operation_duration_seconds_{bucket,count,sum}` | 跨 JVM 的 A2A `SendMessage` 调用 | `operation_name`、`service_name` |
| 授权预校验次数 | `gen_ai_agent_a2at_authorization_preauthorize_count_total` | 网络操作授权 | `authorization_policy_operation_type`、`authorization_result`、`service_name` |
| 授权预校验耗时 | `gen_ai_agent_a2at_authorization_preauthorize_duration_milliseconds_{bucket,count,sum}` | 网络操作授权 | `authorization_policy_operation_type`、`authorization_result`、`service_name` |
| 通知次数 | `gen_ai_agent_a2at_notification_count_total` | 根因、修复方案、修复结果、验证结果上报 | `notification_topic`、`notification_result`、`service_name` |

### Log

OpenSearch 索引 `a2at-logs-v2` 中当前覆盖三类日志：

| 日志 | 来源 | 可观察内容 |
| --- | --- | --- |
| workflow 生命周期 | Workflow Engine | `workflow started`、`workflow completed`、`workflow failed`，以及 workflow ID、类型、状态 |
| step 生命周期 | Workflow Engine | `step started`、`step completed`、`step failed`，以及 step、序号、owner agent、状态 |
| A2A-T Task-T 消息 | MockAgent Router | `MockAgent completed ...` 或错误文本，带 `extension.name=task-t`、任务类型和步骤 |
| 业务任务记录 | MockAgent Router | event name 为 `demo.task`，带 `run_id`、`task_id`、`step`、`skill`、`agent`、`status` |

日志中的 `traceId` 与 `spanId` 可直接用于跳转或调用 Jaeger Trace API；`attributes.run_id` 用于把单次 demo 运行报告和任务日志关联起来。

## 尚未覆盖的 SDK 信号

这些信号在 Observability SDK 的定义中可用，但当前投诉处理故事线没有相应业务行为，因而不会导出样本。

| 未覆盖信号 | 原因 | 何时补充 |
| --- | --- | --- |
| `gen_ai_agent_a2a_streaming_duration_seconds_{bucket,count,sum}` | 当前 A2A 交互是同步 `SendMessage`，没有流式任务 | 引入 `SendStreamingMessage` 或订阅任务状态时 |
| `gen_ai_client_inference_usage_input_tokens_total` / `gen_ai_client_inference_usage_output_tokens_total` | MockAgent 不调用 LLM，也没有真实 token 用量 | 接入真实模型调用时 |

因此，当前 demo 已覆盖 workflow、step、Task-T、A2A 时延、通知计数、授权预校验和三类日志；它不覆盖真实 LLM token 使用；通知和授权行为使用固定的模拟结果。

## 查询全部已入库信号

如果只希望使用 demo 自带 Web 页面，请先阅读 [LOCAL_STORAGE_VIEWING.md 的“只使用自带 Web 页面查看”](LOCAL_STORAGE_VIEWING.md#只使用自带-web-页面查看)。其中包含 Prometheus/Thanos 的全量 Metric 查询和 Jaeger 的全量 Trace 查看步骤。默认栈未包含 OpenSearch Dashboards，因此 Log 没有对应的内置浏览页面。

### 1. 列出所有 Metric 名称和时间序列

Prometheus 的 Graph 页面适合交互式筛选：<http://127.0.0.1:19090/graph>。

PowerShell 直接列出当前库中所有 demo Metric 名称：

```powershell
$names = (Invoke-RestMethod 'http://127.0.0.1:19090/api/v1/label/__name__/values').data
$names | Where-Object { $_ -like 'gen_ai_*' } | Sort-Object
```

查看最近一天内每个 Metric 的完整 label 组合：

```powershell
$matcher = [uri]::EscapeDataString('{__name__=~"gen_ai_.*"}')
$start = [uri]::EscapeDataString([DateTimeOffset]::UtcNow.AddDays(-1).ToString('o'))
$end = [uri]::EscapeDataString([DateTimeOffset]::UtcNow.ToString('o'))
Invoke-RestMethod "http://127.0.0.1:19090/api/v1/series?match[]=$matcher&start=$start&end=$end"
```

若要查看某个 Metric 在时间窗口内的样本值，改用 `query_range`：

```powershell
$query = [uri]::EscapeDataString('gen_ai_agent_a2at_workflow_count_total')
$start = [uri]::EscapeDataString([DateTimeOffset]::UtcNow.AddDays(-1).ToString('o'))
$end = [uri]::EscapeDataString([DateTimeOffset]::UtcNow.ToString('o'))
Invoke-RestMethod "http://127.0.0.1:19090/api/v1/query_range?query=$query&start=$start&end=$end&step=60"
```

若只查看一类 Histogram 的调用次数，请使用 `_count` 后缀，例如：

```promql
gen_ai_agent_a2at_task_duration_milliseconds_count
```

### 2. 查看全部 Trace 和 Span

打开 <http://127.0.0.1:16686/>，依次选择四个服务：`complaint-waimo`、`complaint-transport`、`complaint-west`、`complaint-east`，Operation 保持 All，然后点击 Find Traces。打开 WAIMO 的 `a2at.workflow` Trace 即可看到整个跨 Agent 调用树。

从日志或验证产物取得 Trace ID 后，可获取完整 Trace JSON：

```powershell
Invoke-RestMethod 'http://127.0.0.1:16686/api/v3/traces/<traceId>'
```

验证脚本已将本次关联到的 Trace ID 保存到：

```text
artifacts/<run_id>.storage.json
```

### 3. 列出全部 Log，并按运行筛选

当前默认栈没有 OpenSearch Dashboards，因此使用 OpenSearch REST API。下面查询按 `observedTimestamp` 排序；不要使用不存在的 `@timestamp` 字段。

```powershell
$body = @{
  size = 1000
  sort = @(@{ observedTimestamp = @{ order = 'asc' } })
  query = @{ match_all = @{} }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri 'http://127.0.0.1:19200/a2at-logs-v2/_search' `
  -Method Post `
  -ContentType 'application/json' `
  -Body $body
```

按单次运行筛选，并保留 Trace 关联字段：

```powershell
$runId = 'signal-check-001'
$body = @{
  size = 1000
  sort = @(@{ observedTimestamp = @{ order = 'asc' } })
  _source = @('observedTimestamp', 'body', 'severityNumber', 'traceId', 'spanId', 'attributes', 'resource.attributes')
  query = @{ match = @{ 'attributes.run_id' = $runId } }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri 'http://127.0.0.1:19200/a2at-logs-v2/_search' `
  -Method Post `
  -ContentType 'application/json' `
  -Body $body
```

索引结构与文档总量：

```powershell
Invoke-RestMethod 'http://127.0.0.1:19200/a2at-logs-v2/_mapping'
Invoke-RestMethod 'http://127.0.0.1:19200/a2at-logs-v2/_count'
```
