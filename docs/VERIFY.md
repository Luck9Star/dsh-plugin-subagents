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
- **2026-08-15 冒烟报告 7 项 FAIL 归因修正**（报告本体：
  `smoke-report-dsh-plugin-subagents-20260815.md`，只读参考）：
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

状态：2026-08-15 真机验收通过（A1–A15；A10/A16/A17 已按「settings-UI 回弹」根因修正——A10 产物非法、A16/A17 结论推翻；A18 已在修复版副本上重做挂载验证 ✅）。
2026-08-15 晚间追加：preset L2 挂载根因修复 + E3 lossless-JSON 修复（见「已知边界」两条目），本机
orchestrator-subagents 副本已删除重生成；A18 经独立实例 RPC `session.create` 确认修复版真实挂载成功
（B 节工具面运行时清单仍待用户在 GUI 新会话逐项确认）。
