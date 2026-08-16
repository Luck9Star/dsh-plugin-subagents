# T19 真机验收清单（VERIFY）

> 执行环境：dsh 0.1.0-rc.6（npx live 根 `~/.npm/_npx/1e7f6d9597241db0`），profile `web`。
> 本清单前半部分已由主会话执行并记录证据；后半部分需用户重启后在新会话中确认。

## A. 已完成并验证（本会话执行）

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| A1 | live 根动态解析（which dsh → realpath → 上溯） | ✅ | install.sh 输出 `[ok] live root : /Users/yangyitian/.npm/_npx/1e7f6d9597241db0`，版本 0.1.0-rc.6 |
| A2 | 两段式 install：A 段双链接修复 | ✅ | 插件仓库实体副本 → 符号链接（npm install 后曾出现实体副本）；profile 链接本已正确（幂等跳过） |
| A3 | B 段两枚 cwd 补丁（四态状态机→applied） | ✅ | `inProcessDriver=applied  subagentBundle=applied`，`.bak_cwd` 备份 ×2，stamp 写入 `patches/.applied` |
| A4 | 行为探针对真实 rc.6 根只读验证 | ✅ | T16 交付时执行：正确判定「未原生转发 per-call cwd」（补丁必要性实锤） |
| A5 | doctor（verify.sh）全项 | ✅ | `(a) live root OK (b1/b2) applied (c) 两链接 OK (d) 版本一致`，`VERIFY_EXIT=0`；pnpm 变更后复跑仍 OK |
| A6 | profile 接线：依赖换轨 + bundle 注册 | ✅ | package.json：移除 legacy-bridges-plugin 依赖、新增 dsh-plugin-subagents link、bundles 列表追加；pnpm install 成功；旧符号链接清除 |
| A7 | grok ACP 配置迁移 | ✅ | profile cordis.patch.yml：旧行删除，新 `- id: subagents` 定向覆盖行携带 `providers.grok`（grok agent --always-approve stdio） |
| A8 | 模块加载冒烟（profile 上下文） | ✅ | `import('dsh-plugin-subagents')` → `MODULE_LOADED: dsh-plugin-subagents`（peer 解析含 dsh-tools 符号链接全部成功） |
| A9 | 两份 patch YAML 语法预检 | ✅ | profile 层 3 行、插件 bundle 层 3 行均可解析（防重启时 loader 报错） |
| A10 | L2 preset 适配（orchestrator） | ⚠️ 已修正 | 当时产物含非法行（见下方「settings-UI 回弹」根因）：L2 把 fork 行改写为 `presetRow: true, provider: fork, toolName: subagent_fork`，被 lib/config.js 拒绝。**该产物从未成功挂载**；A10 的「8 行角色行 → presetRow 增强」描述的是生成物形状，不是挂载结果。修复后（fork/bridge 行删除）已重新生成并通过逐行 validateConfig |
| A11 | 测试套件 | ✅ | 316/316 全绿（pipefail 门禁 + 独立计数核验）；本次修复后 346/346 |
| A13 | 真实 grok ACP 桥接冒烟（bridge 层直连） | ✅ | `grok agent --always-approve stdio`；create→submit→stopReason completed→精确回显 BRIDGE_SMOKE_OK→dispose；SMOKE_EXIT=0 |
| A14 | 真实 codex CLI 桥接冒烟（bridge 层直连） | ✅ | codex JSONL bridge；create→submit→completed→精确回显 CODEX_SMOKE_OK→dispose；SMOKE_EXIT=0 |
| A12 | 回滚材料 | ✅ | profile package.json / cordis.patch.yml 备份于 /tmp/profile-*.backup.*；补丁 .bak_cwd ×2；uninstall.sh 可还原 |
| A15 | 真实 GUI 引导（用户重启） | ✅ | 插件条目干净加载；实测暴露并修复两处 Cordis 契约缺陷：inject 缺 systemPrompt（72d7d40）与 apply 返回非空对象被判 Invalid effect（3360252），各带回归防线；修复后限时引导探测「loader entry subagents」零失败（仅余 GUI 并存的预期 EADDRINUSE） |
| A16 | preset L2 副本真实组合 | ❌ 结论已推翻 | 当时「新会话成功组合、工具面出现 backend/role 参数」与时间线矛盾：会话持久化记录显示**没有任何会话曾以 orchestrator-subagents 挂载成功**（两个主会话创建时均为 standard）。当时看到的 backend/role 参数来自**全局层插件工具**（原始 orchestrator preset 未遮蔽新名工具，全局 subagent 恰好透出全参数），presetRow 面从未加载。真实验证待修复版 preset 重新挂载后重做 |
| A17 | 8 行角色化 presetRow 行 | ❌ 结论已推翻 | roster 扫描只证明 YAML 行形状合法，不证明挂载成功；实际挂载在 `tool-subagent-fork` 行被 config 校验拒绝时整体失败（错误原文见下方根因）。修复后产物为 5 行（fork/bridge 行删除），逐行 validateConfig 通过 |
| A18 | **修复版 preset 真实挂载验证（RPC `session.create`，A16 重做·挂载面）** | ✅ | 独立一次性实例（`dsh --profile web --port 3977`，与 GUI 3080 / 复现实例 3917 隔离，验证后已关停）上 `POST /api/session.create {agentPreset:"orchestrator-subagents"}` → `ok:true`，返回 `{sessionId:"session-ccc8b0e9-…", agentPreset:"orchestrator-subagents"}` —— 与捕获原始挂载错误的**同一条决定性路径**，现为阳性。阴性对照：`agentPreset:"no-such-preset-id"` → `ok:false, code:"agent-preset-not-found"`（roster 列出 orchestrator-subagents），证明该路径确实校验并报错、非无条件 ok。挂载成功即含 `inactiveRows` 检查通过 = 全部行（含 5 行 presetRow 插件行与官方 control 行）激活。会话工具面的运行时行为（B 节清单）仍需用户在 GUI 新会话确认。验证产生的空白会话记录（session-ccc8b0e9-…，cwd /tmp）已当即经 `workspace.archiveSession` 归档清理（同法二次起 3977 实例执行；`workspace.list` 4 工作区均不含该会话，GUI 侧栏不再出现；session.list 全量清单仍含已归档条目属预期） |
| A19 | **冒烟 v2（修复版 preset + E3 修复）**：17 PASS / 0 FAIL / 2 SKIP | ✅ | 修复版副本上重跑全量冒烟；明细见下方「冒烟 v2 明细」小节 |

### 冒烟 v2 明细（2026-08-15 晚间 · 修复版副本上 · 17 PASS / 0 FAIL / 2 SKIP）

- **P0 全过**：新建会话默认挂载 orchestrator-subagents 成功，工具面齐全 —— `plan_agent` 等
  presetRow 角色行可用且带 per-call 覆盖参数；`subagent` 全参数 schema 透出
  （backend/role/model/persona/toolFilter/cwd/permission_mode）。
- **F1 回归点过**：`subagent_progress` / `subagent_wait` 返回合法 JSON（E3 修复生效）。
- **D2（前台 codex）PASS**：磁盘证据 `~/.codex/sessions/2026/08/15/rollout-2026-08-15T21-44-57-01a005ab-….jsonl`
  （16 行，13:44:57.278Z–13:45:05.567Z 窗口）含身份探针原文与 assistant 回答 `"Codex"`。
- **D1b（后台 grok）PASS**：registry 条目 `backend=grok` 的 remoteSessionId 精确映射
  `~/.grok/sessions/<cwd>/01a005d0-…/chat_history.jsonl`（mtime 22:26:03），内含探针原文与回答
  `{"content":"Grok","model_id":"grok-4.6-build"}`。
- **SKIP×2**：P0-3（条件不成立）；E2（未知 role 被 schema enum 前置拦截，运行时二道防线代码在位
  未触发，属预期分层）。
- 验收协议本体已存档于 docs/smoke-prompt-v2.md（v1→v2 演进：P0 环境前置门、schema 原文引用纪律、身份探针判据、F 项确定性后台生命周期、F3 信息项化）。

## B. 需用户执行（重启后生效）

1. **重启 dsh**（GUI 进程重启；本会话运行于该进程上，无法自行重启）。
2. **切换 preset**：Settings > General > Agent preset → 「编排主控（主代理调度 + 双模型子代理）+subagents」。**注意**：早前「settings.yaml 手改已验证生效」的记录已修正 —— 当时新会话实际加载的是**原始 orchestrator preset + 插件全局工具**（全参数 `subagent` 恰好透出，故看似生效），orchestrator-subagents 的 presetRow 面从未加载成功（见下方根因）。修复版副本已重新生成，切换后需按本清单重新验证。
3. **开新会话**，验证以下行为（可让 agent 自查或直接观察）：
   - [ ] 会话内可见 `subagent`（统一委派，参数含 backend/role/model/persona/toolFilter/cwd/permission_mode）与 `subagent_fork`
   - [ ] 可见 `subagent_submit / subagent_progress / subagent_wait / subagent_roles / subagent_agents`
   - [ ] `subagent_roles` 列出 general/explore/code-review/debug/codex-full/claude-readonly（backend 列）
   - [ ] `subagent_agents` 显示 grok（ACP，PATH 检测）与 native spawn/fork 可用
   - [ ] 委派冒烟：`subagent` 默认走 native（in-process）；`backend=codex`（如装有 codex CLI）或 role=codex-full 走 bridge
   - [ ] cwd 冒烟：`subagent(prompt="run pwd", cwd="<某绝对路径>")` 子代理 pwd 等于该路径（两补丁生效的直接证据）
   - [ ] 旧 product_* 工具不再存在（除 legacy 别名场景——本机 registry 无旧条目，不应出现）
   - [ ] `plan_agent` 等 presetRow 增强行可用且带 per-call 覆盖参数

## B2. D2b 复测协议（relay 回合闭环校验，修复后执行）

> 背景：D2b 原始证据见「已知边界」区 backlog 条目（2026-08-15 22:25 窗口）。
> 修复 = 确定性 guard（lib/relay-guard.js）+ persona 硬化句 + progress/wait
> 观测标记；机制与边界见 DESIGN §5.4.1。以下协议在**重启后的新会话**执行。

1. **主复现（应 PASS）**：`subagent {backend:"codex", prompt:"Which
   product/CLI are you running as? Reply with the product name only.",
   run_in_background:true}` → `subagent_wait` 该子代理。
   判据（全部满足才算过）：
   - 最终 answer 含 "Codex"（远端真回答），**或** answer 带
     `[relay-guard: not forwarded via subagent_submit …]` 前缀且子代理日志
     显示 guard 拒绝后模型补调了 subagent_submit；
   - `~/.codex/sessions/…` 出现对应时间窗的新 rollout 文件（磁盘工件）；
   - `subagent_progress` 该子代理：`relayEpochSubmits >= 1`。
2. **guard 拒绝路径（行为观察）**：若 relay 首次仍尝试零转发 report，子代理
   侧工具结果应出现 `Error: You are a bridge relay: …` 文本（guard 拒因），
   且回合未中断（子代理继续调 subagent_submit）。
3. **阴性对照（native 不受扰）**：native 子代理正常 report（无 guard 拒绝，
   progress 无 relayEpochSubmits/relayGuardFlag 键）。
4. **开关回归（可选；判据为配置装载直证）**：`relayReportGuard: false` 的回归验证分两段，各确定性覆盖——
   a) **装载段（patch.yml → loader，真机直证）**：在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `subagents` 行 config 下加 `relayReportGuard: false` 后，`dsh --profile web --dump-config` 的合成树中 `subagents` 行 config 必须出现 `relayReportGuard: false`（YAML 缩进错误/落错层级会在此现形）；行为观察（bridge relay 的 report 不被 guard 拒、progress 仍带观测键）仅作辅助旁证——relay 转发优先的新基线下，单凭行为无法区分「开关生效」与「配置未加载」。
   > （判据已实证可执行：2026-08-16 于本机 `dsh --profile web --dump-config`
   > EXIT=0、568 行合成树，`subagents` 行 L556-564 的 config 键——
   > idleTimeoutMs / maxConcurrentChildren / providers.grok.*——完整穿透
   > 合成存活；加 `relayReportGuard: false` 行后同位置出现即为装载成功。）
   测完删除该行并重启恢复默认。
   b) **消费段（loader → 插件，套件已钉死）**：`relayReportGuard: false` 时 guard 不注册（零 contribution）、观测键保留，由 test/index.test.js 的开关分支用例覆盖，无需真机重复。
   （原「需改 profile 并重启 web，与复测会话互斥」的流程性说明保留在条目末尾。）
5. **冷恢复两 epoch（评审追加）**：冷恢复（binding 已释放、registry 条目在）
   的新 epoch 必须**重新归零**计数——否则前一个 epoch 的 submit 残留会让新
   epoch 的零转发自答 report 漏拒。两种可执行变体：
   - a) **idle 超时唤醒**：完成第 1 步后等待 idle 超时（profile 配置
     `idleTimeoutMs: 600000`，10 分钟），再 `send_message` 唤醒同一 bridge
     子代理、重发一次自指型探针（"Which product/CLI are you running as?
     …"）。判据 = 新 epoch 内 report 先被拒（子代理日志出现
     `Error: You are a bridge relay: …`）或先出现 subagent_submit，且最终
     answer 干净（无 relay 自答冒充）；
   - b) **重启后恢复**：重启 dsh（web），`send_message` 唤醒 registry 记录的
     该子代理（registry 是唯一恢复源），重发自指型探针，判据同上（a）。
   > 该场景已由 live-root probe 复证（2026-08-15，修复后；脚本
   > `scripts/d2b-live-root-probe.mjs`，运行本脚本可随时再生（一次性
   > stdout），期望 22 PASS / 0 FAIL）：真实 `SubagentActivationSetupRegistry`（自 live
   > root 逐字提取，锚点校验）+ 本仓真实
   > `createBridgeState`/`attachBridgeLifecycle`/`attachRelayGuard`——两
   > epoch 冷恢复场景中 epoch2 计数归零（binding ∪ registry 并集）、零
   > submit report 被真实 registry 装配的 guard 拒绝（RELAY_GUARD_REASON
   > 原文）、end 零-submit 告警触发、补 submit 后放行；installer 返回
   > function disposer、调用后 guard 失效，contribution 移除路径
   > （releaseAll → installation.dispose()）不再抛
   > "installation.dispose is not a function"（含 undefined-returning
   > installer 的灵敏度阴性对照）。probe（`scripts/d2b-live-root-probe.mjs`）
   > 为仓库内持久路径，可重复执行；输出为一次性 stdout，如需留存可用 tee。
6. **磁盘/registry 佐证**：registry 条目 `backend=codex` 的 remoteId 非空。

### B2 执行结果（2026-08-16 13:23–13:36，修复 91c1f95 + probe 持久化 9739200）

1. **总表**：P0 PASS / 1 主复现 PASS（三判据全满足）/ 2 guard 拒绝路径 PASS-转发优先（relay 首次即正确转发，guard 分支由套件 D2b 用例覆盖）/ 3 native 阴性对照 PASS / 4 开关回归 SKIP（需改 profile 并重启 web，与复测会话互斥；开关分支已由测试覆盖）/ 5a 冷恢复 idle 唤醒 PASS / 5b 重启恢复 SKIP（同上，留作后续专项：以 registry 条目 60e364b7-5074-4f58-9526-aa4743cd63a0 为目标）/ 6 registry 佐证 PASS。**0 FAIL**。
2. **关键证据摘要**（原文数字）：
   - **主复现**：childId 60e364b7…，`subagent_wait` 返回 `{status:completed, answer:"Codex"}`（无 relay-guard 前缀）；磁盘新 rollout `rollout-2026-08-16T13-23-40-01a00906-….jsonl`（首行 05:23:40.274Z）含探针原文 ×2；`subagent_progress` `relayEpochSubmits:1`。
   - **5a 冷恢复**（epoch 归零判别式——advisor 口径，固化为复测标准）：**先记 epoch-1 终值、再取 epoch-2 值，重置 ⇒ epoch-2 ≤ epoch-1（典型 1），延续 ⇒ 累加为 2**。本次：idle 660s（>600000）唤醒同一 childId，epoch-2 `relayEpochSubmits:1`（若延续应为 2 → 归零证实）；无 guard 拒因、1 次 `subagent_submit`、answer "Codex" 干净；rollout 同文件续档 102963→107409 字节、探针计数 2→4、末事件 `task_complete`（05:36:32.980Z, `last_agent_message:"Codex"`）。
   - **registry 佐证**：本次条目 `backend=codex`、`remoteId=01a00906-…`（与 rollout 文件名、`subagent_progress` remoteSessionId 三方一致）；旁证——registry 中两条修复前 codex 旧条目（ff027c1e、1c4133d2）remoteId 为空，即修复前缺陷历史痕迹。
3. **结论行**：D2b 修复真机验证通过——转发优先、epoch 计数归零、registry 冷恢复链路完整；5b/4 为后续可选项（非缺陷）。

## C. 已知边界

> 补充说明：A13/A14 两条冒烟是 bridge 层**直连**真实 agent 的协议级端到端
> （create→submit→completed→精确回显→dispose）；经 dsh 工具面的完整委派链路
> （`subagent` 调用 → 驱动 → 桥）验证属 B 节重启后清单。

- npx 缓存漂移：任何 `reading 'prepare'`（工具全挂）或「cwd 静默失效」症状 → 重跑 `patches/install.sh` 或先 `patches/verify.sh`（README「Upgrading dsh / npx cache drift」节）。
- dsh 升级后：node_modules 重写 → 重跑 install.sh（幂等）+ verify.sh；preset 副本在 DSH_HOME 下不受影响。
- npm 发布前：package.json 的 repository/homepage/bugs 为占位 URL，需改为真实仓库地址。已设 CI 硬门禁：publish.yml 在发布前检测占位地址并失败。
- **设置 UI 选择器静默回弹（根因已钉死：preset 挂载失败，非 dsh 设置设施缺陷）**。
  症状——新建会话选择器点击「…+subagents」后标签跳回原项、新会话回退 standard、用户未见错误文本。
  **已验证根因**：当时 L2 产物（`orchestrator-subagents`）含非法行 —— fork 行被改写为
  `presetRow: true, provider: fork, toolName: subagent_fork`，插件自身 config 校验（lib/config.js）
  拒绝该形状（presetRow 行注册的是 spawn 语义委派工具，禁止冒用全局实例 fork 工具默认名）。
  行级校验失败 → **整个 preset 挂载失败** → UI 选择器弹回与新建会话回退 standard 都是挂载错误被
  UI 吞掉的表现。经 RPC `session.create` 捕获的挂载错误原文（决定性证据）：

  ```
  agent-presets: preset "orchestrator-subagents" failed to mount: failed to apply loader entry
  delegation (cordis:group): failed to apply loader entry tool-subagent-fork (dsh-plugin-subagents):
  dsh-plugin-subagents: invalid config — presetRow 行必须使用与全局实例 delegate/fork 及其它
  presetRow 行不同的 toolName（如 plan_agent / scout_agent，见 DESIGN §6.3-L2）；当前撞名：
  toolName "subagent_fork" 与全局实例 fork 工具的默认名相同（且本行注册的是 spawn 语义的委派
  工具，冒用 fork 名只会误导模型）。Preset-row rewrites must register a distinct toolName.
  (/Users/yangyitian/.dsh/.agent-presets/orchestrator-subagents/agent.cordis.yml)
  ```

  会话持久化时间线佐证：没有任何会话曾以 orchestrator-subagents 挂载成功过；两个主会话创建时
  均为 standard。**修复**：preset-adapt L2 现在只改写 `provider: spawn` 且 toolName 不撞全局名的
  行，通用/fork/bridge 行一律删除（DESIGN §6.3-L2）；回归硬闸门（test/preset-adapter.test.js）
  断言 L2 产物每行过 validateConfig；本机副本已删除重生成（5 行 spawn 角色行全过校验）。
  **复现/诊断协议（保留，下次疑似挂载失败时用）**：UI 吞错误时，用 RPC `session.create`（带
  目标 preset）直接创建会话 —— 挂载错误在该路径**不被吞**，`agent-preset-invalid` 与行号原文
  可完整捕获；配合会话持久化记录核对「会话创建时实际加载的 preset」即可区分「选择器写入失败」
  与「preset 挂载失败」两类症状。
- **2026-08-15 冒烟报告 7 项 FAIL 归因修正**（报告本体位于仓库外上级目录
  `../smoke-report-dsh-plugin-subagents-20260815.md`，即
  `/Users/yangyitian/Documents/dev/Agents/dsh/` 下，只读参考）：
  - C2/C3/D1/E1/E2（backend/role/cwd/model 参数被 schema 剥离）与 A2（presetRow 角色化工具缺席）
    = **环境面错配而非工具实现缺陷**：冒烟会话跑在 cordis 内置 preset 上，官方 3 参数 subagent
    遮蔽了插件全参数工具；preset 修复重挂载后即恢复，插件工具面无需改动。
  - E3（`subagent_progress`/`subagent_wait` 对所有子代理报
    `returned invalid output: value is not lossless JSON`）= **真缺陷，已修**：dsh-tools 经
    dsh-session 的 `snapshotJsonValue` 快照工具返回值，**任何自有属性值为 `undefined` 的对象整体
    被拒**；观测族工具的返回对象在常见路径上必然携带这类键（`mode: … : undefined`、
    `turn/lastTask/…: fold ? … : undefined`、trace 条目的 `at: safeIso(undefined)` 等）。
    修复：新增 lib/json-safe.js 深度清洗器（undefined 键删除、Date→ISO、Map/Set→数组、
    Error→{name,message}、循环引用安全等），统一套在 progress/wait/roles/agents 四个观测工具的
    返回边界；test/json-safe.test.js 用与生产完全相同的 `snapshotJsonValue` 闸门钉死回归。
     - **名字独占性证据（防止归因翻案）**：E3 归因曾受质疑（「冒烟会话跑 cordis preset，
       progress/wait 可能是官方 control 工具」），经两层 grep 排除：
       第一层（初查，后被补严）：live root
       `~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/` 内
       `"subagent_progress"` / `"subagent_wait"` 双引号锚定 *.js 零命中；
       第二层（补严：去锚定 + 扩展名 .js/.yml/.yaml/.json + 五个名字全查）：同目录下
       `subagent_progress / subagent_wait / subagent_submit / subagent_roles /
       subagent_agents` 全部零命中（排除 .map 与本插件包），并对其余 profile bundle 依赖包
       （@mstar-harness/dsh、dsh-advisor、@loserfox/distill、@linxin666/dsh-web-ui-all、
       @dsh-external/workflow）同样五名零命中；阳性对照：本插件仓 lib/ 内命中。
       结论：五个工具名宿主侧仅本插件注册，cordis 会话中 E3 打到的就是本插件全局层工具；
       且报错为 "returned invalid output"（工具已执行、返回值过快照校验失败），与「查找失败」
       相区分。可复现命令原文（单行，供下次直接粘贴执行）：
       `cd <live-root>/node_modules/@deepseek-ai && for n in subagent_progress subagent_wait
       subagent_submit subagent_roles subagent_agents; do grep -rl "$n" --include='*.js'
       --include='*.yml' --include='*.yaml' --include='*.json' . | grep -v '\.map$'; done`
       （预期除本插件包外零输出）
       独立复核（2026-08-15，另一 agent 以**双引号锚定**变体 `grep -rl "\"$n\""` 对五名重跑）：
       同样零命中 —— 锚定与非锚定两层独立一致。阳性对照精确引用：四名以字面
       `name: 'subagent_*'` 注册于 lib/tools/；`subagent_submit` 经 registerSubagentSubmit 的
       `toolName = 'subagent_submit'` 默认参注册（lib/tools/subagent-submit.js:52,73）。
   - **官方 control 行去留的裁决（T-F 核实结论，2026-08-15）**：问题——L2 产物保留官方
     `tool-subagent-control` 与 `tool-subagent-control/list-agents` 两行，是否会让 preset 会话
     的子代理管理工具看不到本插件创建的子代理（bridge 子代理与 presetRow 原生 spawn 子代理
     两类）。裁决——**保留**。证据（两条）：
     - bridge 子代理：lib/drivers/bridge.js 的 continuable 路由经
       `ctx.subagents.startContinuable({provider: <bridge名>, ...})` 创建，服务层持有记录；
     - 原生 spawn 子代理（含 5 行 presetRow 行的派发）：lib/drivers/native.js 的 continuable
       路由同样经 `ctx.subagents.startContinuable(...)` 创建（native.js L235 附近），服务层持有记录；
     - 官方 send_message（`ctx.subagents.followup`，control 包 lib/index.js:57）/ interrupt_agent /
       list_agents 全部走服务层，对两类子代理均可见可操作；本插件内部 state.bindings 只是
       pinnedProduct/remoteSessionId/settings 的补充记录，不是存在性来源。
     名字归属澄清：本插件全局层注册 subagent / subagent_fork / subagent_submit /
     subagent_progress / subagent_wait / subagent_roles / subagent_agents 七个名字，不注册
     send_message / interrupt_agent / list_agents；preset 层官方 control 行与宿主平面同包同实现，
     保留无行为差异。
     删除官方 control 行无必要；本插件 progress/wait 以全局层顶名，携带 bridge-aware 富数据
     （pinnedProduct / remoteSessionId）。证据文件位置：lib/drivers/bridge.js continuable 路由、
     lib/drivers/native.js L235 附近、官方 dsh-tool-subagent-control lib/index.js:57 的 followup 调用。
- **【backlog · P2 行为缺陷 —— ✅ 已修复（DESIGN §5.4.1），复测协议见 B2】**
  continuable bridge relay 在自指型 prompt 下可不经
  `subagent_submit` 转发、以 report 自答**（如回答宿主框架名），造成产品身份静默错误归因。
  证据链（D2b，2026-08-15 22:25 窗口）：relay descriptor/persona 正确（"You are a relay bridge to
  the Codex CLI agent. For every user message you receive, call subagent_submit…"）；工具面
  ['report','subagent','subagent_submit'] 符合只读管道红线；relay reasoning 显示按自身系统提示
  自答（"I'm running as DeepSeek Harness (DSH)"）；全部工具调用仅 report（seq 632/633），无
  `subagent_submit`；佐证：窗口内无新 codex rollout、registry remoteId=—。
  最小复现：`subagent {backend:"codex", prompt:"Which product/CLI are you running as? Reply with
  the product name only.", run_in_background:true}`。
  修复（两层加固方向均已实现）：a) 确定性回合闭环校验 —— registerContinuableSetup +
  childCtx.tools.guard 拒绝零转发 epoch 的 report（lib/relay-guard.js）+ progress/wait 观测标记
  + relayReportGuard 开关；b) persona 硬化句（"NEVER answer from your own knowledge, identity,
  or runtime…"）。单测：test/relay-guard.test.js 等。
- **【backlog · P3 —— ✅ 已修复】subagent 工具的 backend 参数描述文案 "(none detected on this deployment)" 与
  enum 全量矛盾**——根因（调查钉死）：enum 与描述同数组同源，真机「矛盾」是 presetRow 行空 bridges 的
  文案撒谎（部署明明检测到 bridge，只是本行不可用）。修复：描述三态 —— 非空 `join(' / ')` /
  空且 presetRow → native-only 指引全局工具 / 空且全局实例 → 诚实 "not detected"（指向 subagent_agents）。
  一致性不变式入测（test/subagent-tool.test.js：非空时描述逐一包含 enum.slice(1) 每个名字、
  三态均不再出现 `none detected` 误导）。
- **【backlog · P3 —— ✅ 已修复】subagent_progress 的 trace brief 占位符**：payload 缺 turn/step 时
  ~~输出 "turn undefined start / step undefined.undefined"~~（lib/progress.js compactEvent）——
  已改为省略编号（`turn start` / `turn end` / `step start`；编号齐全维持 `turn N start` / `step N.M`
  原样，回归用例钉死）。
- **INFO 备忘（设计现状，非缺陷）**：前台 bridge 调用不返回 childId、不进 list_agents —— 宿主侧
  取证需后台模式或磁盘工件。

状态：2026-08-15 真机验收通过（A1–A15；A10/A16/A17 已按「settings-UI 回弹」根因修正——A10 产物非法、A16/A17 结论推翻；A18 已在修复版副本上重做挂载验证 ✅）。
2026-08-15 晚间追加：preset L2 挂载根因修复 + E3 lossless-JSON 修复（见「已知边界」两条目），本机
orchestrator-subagents 副本已删除重生成；A18 经独立实例 RPC `session.create` 确认修复版真实挂载成功
（B 节工具面运行时清单仍待用户在 GUI 新会话逐项确认）。
2026-08-15 晚间（续）：冒烟 v2 在修复版副本上重跑完成 —— **17 PASS / 0 FAIL / 2 SKIP**（见上
A19 + 明细小节）；此前 B 节「presetRow 相关项需在修复版副本上重跑」的待办已在修复版副本上重跑
通过（本条目引用）。同次冒烟揭示收尾待办：continuable bridge relay 自指型 prompt 下可不经
subagent_submit 转发、以 report 自答致产品身份错误归因（P2，下一轮修复候选）；另两条 P3 backlog
（backend 描述文案与 enum 不同步、progress trace brief undefined 占位符）与 INFO 备忘见「已知
边界」区。
