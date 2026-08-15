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
| A10 | L2 preset 适配（orchestrator） | ✅ | 8 行角色行 → `presetRow: true` 增强；副本 `orchestrator-subagents`；源 preset 只读未动；marker 写入 |
| A11 | 测试套件 | ✅ | 316/316 全绿（pipefail 门禁 + 独立计数核验） |
| A13 | 真实 grok ACP 桥接冒烟（bridge 层直连） | ✅ | `grok agent --always-approve stdio`；create→submit→stopReason completed→精确回显 BRIDGE_SMOKE_OK→dispose；SMOKE_EXIT=0 |
| A14 | 真实 codex CLI 桥接冒烟（bridge 层直连） | ✅ | codex JSONL bridge；create→submit→completed→精确回显 CODEX_SMOKE_OK→dispose；SMOKE_EXIT=0 |
| A12 | 回滚材料 | ✅ | profile package.json / cordis.patch.yml 备份于 /tmp/profile-*.backup.*；补丁 .bak_cwd ×2；uninstall.sh 可还原 |

## B. 需用户执行（重启后生效）

1. **重启 dsh**（GUI 进程重启；本会话运行于该进程上，无法自行重启）。
2. **切换 preset**：Settings > General > Agent preset → 「编排主控（主代理调度 + 双模型子代理）+subagents」。
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
