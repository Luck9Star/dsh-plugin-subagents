<!--
冒烟验收协议 v2 存档副本；源文件在工作区父目录，v1 报告为 ../smoke-report-dsh-plugin-subagents-20260815.md。
F3 为信息项不计 PASS/FAIL。
-->
# dsh-plugin-subagents 冒烟验收 v2（preset 修复后复测，2026-08-15）

请在新会话中逐项实际调用工具验证。每项给 PASS/FAIL/SKIP + 证据；FAIL 必须附**完整错误原文**与最小复现步骤；所有工具 schema 判据材料必须**原文引用**（把 parameters 的 JSON 原样贴出），禁止转述。最后给结论总表（PASS/FAIL/SKIP 计数）与按严重级排序的异常清单。

## P0 环境前置门（任一不满足 → 报告「P0 FAIL」并停止，不要继续后续项）
1. 本会话为**新建会话且未手动改过 preset 选择器**：先列出工具清单，应存在 `plan_agent / scout_agent / dev_agent / dev_agent_flash / review_agent / subagent_fork / subagent / subagent_progress / subagent_wait / subagent_roles / subagent_agents / subagent_submit / send_message / list_agents / interrupt_agent`。若角色化工具（plan_agent 等）不存在 → 说明默认 preset 又没挂上，P0 FAIL 并停止。
2. `subagent` 的 parameters 须含 `backend / role / cwd / model / persona / toolFilter`（原文引用 schema）。
3. 若 P0-1 失败：在 preset 选择器中手动选「编排主控…+subagents」，观察是否**选中后弹回**；若弹回，截取描述行全部文字记入报告；然后停止。

## A 工具面
- A1：全部 subagent 家族工具名清单（原文）。
- A2：`subagent_fork` parameters 原文引用，须含 override 参数（preset 已删 fork 行，此名应来自插件全局实例）。
- A3：`plan_agent` parameters 原文引用，须含 override 参数（presetRow 行）。

## B 注册面
- B1：`subagent_roles` → 6 角色且每条含 backend 列。
- B2：`subagent_agents` → grok(ACP)/codex/claude-code/acp 全部 available + native spawn/fork registered（原文引用 availability 块）。

## C native 委派
- C1：默认路径子代理回显 pwd = 本会话 cwd。
- C2：`mkdir -p /tmp/dsh-smoke` 后 `subagent {prompt:"运行 pwd 并只回显第一行", cwd:"/tmp/dsh-smoke", run_in_background:false}` → 回显 ∈ {/tmp/dsh-smoke, /private/tmp/dsh-smoke}；并引用调用记录证明 cwd 参数被保留（而非被 schema 剥离）。
- C3：`model:"deepseek-v4-flash"` 覆盖 → 需**可区分证据**（子代理自报模型 id，或 `subagent_progress` 显示目标 model）；仅返回 OK 不算 PASS。
- C4：`subagent_fork` 正确总结本会话上下文（识别出 DSH 初始化、插件环境、总结请求本身）。

## D bridge 委派（身份探针，防回显假阳性）
- D1：`subagent {prompt:"Which product/CLI are you running as? Reply with the product name only.", backend:"grok", run_in_background:false}`。PASS 判据 = (回答为 grok 系)**且**(`list_agents` 显示该 child 为 grok 会话 或 `subagent_progress` 显示 pinnedProduct/remoteSessionId)。「照抄提示词」类回显不算身份证据。
- D2：`backend:"codex"` 同法（codex 身份探针，判据同 D1）。

## E 红线（应大声失败）
- E1：`backend:"grok"` + `cwd:"/tmp"` → 必须报错且错误消息含 `cwd`。
- E2：`role:"不存在的角色xyz"` → 必须报错并列出可用角色清单。
- E3：`subagent_submit {task:"hi"}`（主代理无绑定远程会话）→ 应返回守卫错误（符合设计，记 PASS 非缺陷）。

## F 后台/异步生命周期（确定性覆盖，不依赖其他项）
- F1：显式 `run_in_background:true` 起子代理（prompt:"运行 date 并回显结果，然后结束"），用返回的 childId **立即依次**：
  1. `subagent_progress {subagent_id:childId}` → 合法 JSON 快照（status；上一轮此处报 `value is not lossless JSON`，本轮为回归验证点）；
  2. `subagent_wait {subagent_id:childId, timeout_ms:60000}` → 合法 JSON（final answer / stop reason / trace），状态 ready/completed。
- F2：若 F1-1 时子代理已完结（看不到运行中快照），再起一个 prompt:"运行 sleep 20 后回显 done" 的后台子代理重测 F1-1 的运行中快照。
- F3（信息项，不计 PASS/FAIL）：`send_message` 给已完结子代理发一句话，**记录原始返回**。可接受结局均记 INFO 不记 FAIL：a) 排队回执语义；b) 官方 control 包对已完结 continuable 子代理的显式错误（该行为官方侧未验证过，两种都属正常范围）。仅当错误文本指向本插件面（含 subagents/插件名）时才升级为 FAIL 并原文记录。
