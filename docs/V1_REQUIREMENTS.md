# DeepSeek Harness Model PK 插件：V1 产品需求文档

## 0. 文档信息

| 项目 | 内容 |
|---|---|
| 产品名 | DeepSeek Harness Model PK，简称 DSH Model PK |
| 文档类型 | V1 产品需求与实现契约 |
| 文档版本 | 1.0 |
| 日期 | 2026-08-17 |
| 状态 | V1 范围冻结，可用于后续技术设计与实现 |
| 当前阶段 | 仅建立项目与需求文档，不实现业务代码 |

### 0.1 规范用语

- **必须**：V1 验收的硬性要求，不满足即不可发布。
- **应该**：强烈建议；若不实现，必须在技术设计中记录理由和替代方案。
- **可以**：允许但不要求，不得妨碍必须项。

### 0.2 一句话定义

> 用户只需准备一次任务材料，选择 DSH 中已配置的 N 个模型，即可让这些模型在同一套被冻结的 Prompt、图片、DSH Harness、工具权限、workspace 基线和执行规则下并行完成任务；运行过程同屏可见，单路异常可独立重跑，所有 Attempt 与产物均独立归档。

---

## 1. 背景与问题

目前比较多个模型完成同一任务时，用户往往需要反复切换模型、复制 Prompt、重新上传图片、重新准备项目目录，并手工记录运行状态与结果。这个过程存在以下问题：

1. 同一个 Prompt 可能在复制时被修改。
2. 图片可能被遗漏、换序、重复压缩或使用不同版本。
3. 多个模型可能共享同一 workspace，互相看到对方留下的文件。
4. 模型运行条件、Provider 配置和超时策略无法追溯。
5. 某一路卡死、掉线或超时后，往往只能全部重跑。
6. 重跑覆盖旧结果，无法分析首次成功率和稳定性。
7. 运行结束后，日志、transcript、metadata 和文件产物散落，难以复核。

V1 要解决的不是“自动判断谁赢”，而是先把多模型对照实验本身做得公平、稳定、可观察、可重放、可审计。

---

## 2. 项目定位与评测口径

### 2.1 产品定位

DSH Model PK 是运行在 DeepSeek Harness 体系内的本地多模型对比插件。它不维护第二套模型或 Provider 配置，而是读取 DSH 已配置模型，以一个不可变 Task Package 为输入，创建一个 Experiment，并为每个参赛模型建立独立 Run 和 Attempt。

### 2.2 V1 真正评测的对象

V1 的准确口径是：

> 比较不同模型配置在同一个固定 DSH Harness 下完成同一任务的表现。

它主要控制的变量是 Provider 与 Model 配置。它不是裸模型 API 的实验室 Benchmark，因为 DSH 的系统提示词、Agent Loop、Provider Adapter、工具、workspace 和上下文处理仍然会影响结果。所有这些非模型条件必须被冻结、记录，并在所有 Run 间保持一致。

### 2.3 固定选择的执行方案

V1 采用方案 B：

| 方案 | 说明 | V1 决策 |
|---|---|---|
| A. 插件绕过 DSH，直接调用各 Provider SDK | 可以更接近裸 API，但会复制模型、密钥、附件和调用基础设施 | 不采用 |
| B. 所有模型使用同一套固定 DSH Harness | 复用 DSH 配置与运行能力，主要变量为模型配置 | **采用** |
| C. 调度 Codex CLI、Claude Code CLI 等外部 Agent | 比较的是不同 Agent Runtime 与工具链，不再是模型对照 | 明确排除 |

### 2.4 与 CLI Agent 的硬边界

V1 必须满足：

- 不启动、不调用 Codex CLI。
- 不启动、不调用 Claude Code CLI。
- 不读取或复用上述 CLI Agent 的 session、系统提示词、工具循环、权限或 workspace。
- 不通过 Agent Router 把外部 Agent 包装成模型参赛。
- 不把结果描述为 Codex、Claude Code 或其他 Agent 产品之间的能力比较。
- DSH 自身的 Agent Loop、工具和 workspace 能力可以作为统一 Harness 的组成部分，但每个参赛模型必须得到相同的 Harness Profile、工具清单、工具描述、权限规则和初始 workspace。

---

## 3. V1 目标、成功定义与非目标

### 3.1 V1 目标

1. 从 DSH 读取当前已配置模型并允许用户多选。
2. 让用户只输入一次 Prompt，并可添加多张图片。
3. 冻结 Task Package 和公共执行条件，确保所有模型收到相同实验材料。
4. 在受控并发下为 N 个模型创建相互隔离的独立 Run。
5. 实时显示每个 Run 的状态、输出摘要、最后活动、日志和产物。
6. 正确识别失败、卡死、掉线、超时和取消，并给出结构化原因。
7. 支持单路 Retry、成功单路 Run Again 和批量 Retry Failed。
8. 每次重跑创建新的 Attempt，使用相同 Task Package 和全新干净 workspace。
9. 完整归档 Experiment manifest、Prompt、附件、metadata、transcript、日志和独立产物。
10. 一键打开准确的实验总目录。

### 3.2 V1 核心成功定义

V1 发布时，以下产品承诺必须成立：

> 同一份 Prompt、同一组有序图片、同一 workspace 基线和同一 DSH 执行规则，可以一次交给 N 个已配置模型；单路故障不会影响其他模型；任一重跑不会污染或覆盖历史；实验结束后可以仅凭归档目录还原“谁在什么条件下、何时、如何运行以及产生了什么结果”。

### 3.3 V1 明确不做

- 自动 Judge。
- 自动评分、质量结论或胜负排名。
- Elo。
- 历史排行榜或跨实验榜单。
- Codex CLI。
- Claude Code CLI。
- 其他外部 CLI Agent。
- Agent Router、Agent 自动选择或 Agent 框架横评。
- Prompt 模板库或任务市场。
- Dataset、批量 Benchmark、参数扫描或定时 Benchmark。
- 自动任务级 Retry。
- 复杂成本核算。
- Provider、模型或 API Key 管理。
- 云端同步、团队协作或公开分享平台。

本地持久化、崩溃恢复和重新打开当前实验属于可靠性要求，不属于“历史排行榜”。

---

## 4. 核心概念

### 4.1 DSH Model Config

DSH 中一个可选择的已配置模型项。身份必须由稳定配置 ID 标识，不能只使用显示名称。建议快照字段：

- modelConfigId
- providerId
- providerProfileId，若 DSH 提供
- modelId
- displayName
- modelRevision，若可解析
- inputModalities
- 非敏感的已解析模型参数
- Provider Adapter 版本

同一 modelConfigId 在一个 Experiment 中不能重复选择。同一个基础模型经不同 Provider 或不同 DSH 配置出现时，可以作为不同候选项，但 UI 必须清楚显示 Provider 与配置身份。

### 4.2 Task Package

一次实验被冻结的共同任务输入，至少包含：

- Task Name。
- Task Type；仅作为标签，不得改变系统提示词、工具或执行策略。
- 用户 Prompt 原文。
- 实际使用的系统提示词或其可审计引用。
- 有序图片附件列表。
- 可选 workspace baseline snapshot；无项目输入时明确为空基线。
- 固定 DSH Harness Profile 引用。

Task Package 在 Start PK 后不可修改。任何 Prompt、附件、附件顺序、workspace 基线或 Harness Profile 的变化都必须创建新 Experiment，不能伪装成 Retry。

### 4.3 Experiment

一次完整的多模型对照实验。它持有：

- 一份不可变 Task Package。
- 一份不可变公共 Execution Conditions。
- 一组冻结的模型配置快照。
- 每个模型一个稳定 Run。
- Preflight 快照、版本信息和实验目录引用。

### 4.4 Run

Experiment 中一个模型的稳定参赛席位：

- 一个模型配置对应且仅对应一个 Run。
- Run 在 Experiment 冻结时创建，之后不能换模型或删除。
- Run 不是一次请求；它拥有一个或多个 Attempt。
- Run 的当前展示状态由最新 Attempt 派生，所有历史 Attempt 永久可查看。

### 4.5 Attempt

一次真实执行：

- 初始运行产生 Attempt 1。
- Retry、Run Again、Retry Failed 都产生新的 Attempt。
- Attempt 编号在同一 Run 中单调递增。
- 每个 Attempt 有独立 session、workspace、日志、transcript、metadata 和产物目录。
- Attempt 进入终态后不可覆盖、删除或改写其结果。

---

## 5. DSH 集成边界

### 5.1 职责分工

| DSH 负责 | Model PK 插件负责 |
|---|---|
| 模型注册表、Provider 配置、认证和密钥 | 模型多选、选择快照和展示顺序 |
| 模型能力声明和 Provider 调用 | Task Package 冻结与公平性校验 |
| 统一 Agent Loop、系统提示词、工具和 session | 固定 Harness Profile 并确保每路一致 |
| 附件存储或附件引用能力 | 有序附件清单、hash 和实验归档副本 |
| 流式事件和底层取消能力 | 并发队列、状态机、Watchdog 与用户操作 |
| Provider 请求格式转换 | Run、Attempt 生命周期和独立 workspace |
| 单次执行产生的模型与工具事件 | 实验级日志、transcript、metadata 和产物归档 |

### 5.2 集成规则

- 模型列表只能从 DSH 读取；插件不得提供手工填写 Provider URL、Model ID 或密钥的旁路。
- 插件不得在 DSH 调用失败时静默绕过 DSH 直接调用 Provider。
- 插件应通过单一 DSH Adapter 边界接入，领域层不得依赖 DSH 内部 UI 或不稳定 DOM。
- 模型配置 ID 与显示名必须分离。
- Experiment 必须记录 DSH 版本、插件版本、模型配置 ID、Provider ID、能力声明和 Adapter 版本。
- DSH 配置在 Experiment 冻结后发生漂移时，Retry 不得静默使用新配置。若无法按冻结快照执行，应阻止重跑并显示 MODEL_CONFIG_DRIFT。
- 密钥只由 DSH 管理，任何 manifest、metadata、日志和 transcript 都不得保存明文凭据。

### 5.3 实现前必须验证的 DSH 能力

进入业务实现前需完成只读兼容性确认：

1. 稳定的模型枚举和配置 ID。
2. 模型输入模态能力查询。
3. Provider 可用性或健康检查接口。
4. session 创建、流式事件、最终结果和取消接口。
5. 页面刷新或宿主重启后的 session 查询或重连能力。
6. 附件持久化与不可变引用接口。
7. workspace 创建、隔离或快照能力。
8. DSH 插件 UI 的正式扩展点。

若某项能力不存在，技术设计必须显式提出最小替代方案；不得通过抓取 DSH UI、读取密钥或静默降级来绕过。

### 5.4 已核验的官方基线

截至 2026-08-17，官方资料已确认：

- DSH 当前处于 Developer Preview，明确可能出现兼容性破坏，因此实现必须固定并记录受支持的 DSH 版本或 commit，不能依赖“最新版永远兼容”。
- DSH 采用插件架构；模型 Adapter、工具注册表、session log 和 Agent Loop 都是可替换插件能力。
- 官方架构提供 ctx.llm、ctx.sessions、ctx.tools、ctx.agents、session/event 和 Web Client 扩展方向，适合通过正式边界实现 Model PK。
- 官方 Web UI 已有 Settings → Models 和 workspace 选择。
- 官方模型配置支持 Provider、Model ID 与 image input 声明；未声明图片能力的模型会在发送前拒绝图片。

实现时应以官方仓库实际受支持版本的类型与扩展文档为准：

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [官方架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [官方 Web UI 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)
- [官方模型与 Provider 配置指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)

---

## 6. 公平性契约

### 6.1 V1 固定 Fair Mode

V1 只提供 Fair Mode，用户不能关闭。每个 Run 必须满足：

- 相同用户 Prompt 原文。
- 相同逻辑系统提示词。
- 相同图片字节、数量和顺序。
- 相同 workspace baseline snapshot。
- 相同 DSH Agent Loop 与 Harness Profile。
- 相同工具清单、工具描述和权限规则。
- 相同上下文策略、最大步骤、输出上限、硬超时、卡死阈值和取消策略。
- 全新独立 session，无历史对话、记忆、缓存或其他模型输出。
- 独立 workspace，不能读取兄弟 Run 或历史 Attempt 的 workspace。

唯一允许主动变化的是冻结的 modelConfigId 所对应的 Provider 与 Model 配置。

### 6.2 图片公平性

- “相同图片”指相同原始字节与相同顺序，不只是文件名相同。
- 插件不得为某个模型单独压缩、转码、OCR、描述图片、删图或换序。
- 内部可以按内容 hash 去重存储，但 manifest 必须保留用户提交的完整有序序列。
- 插件向每个 Run 传入的必须是同一不可变图片字节或同一 content-addressed reference。Provider Adapter 为协议所做的 base64、multipart 等无损封装差异可以存在，但必须记录 Adapter 版本。
- 若 DSH 或 Provider Adapter 会做缩放、重压缩、裁剪、格式转换等改变视觉内容的有损转换，Preflight 必须展示该限制；无法对所有 Run 使用相同有损规则时，该模型不得参加本次实验。
- 包含图片时，只允许原生支持 image input 的模型通过 Preflight。
- 不得用另一个视觉模型先解释图片再把文字交给纯文本模型。

### 6.3 参数公平性与模型固有差异

- V1 不提供逐模型 Temperature、Thinking、Reasoning Effort 等高级参数编辑。
- 公共限制使用同一固定值；某模型不支持强制公共参数时，Preflight 必须阻止该实验开始，不能静默丢弃参数。
- 模型自身在 DSH 中的标准默认参数属于模型配置快照，允许不同，但必须可见并写入 metadata。
- Provider Adapter 的协议序列化差异是固有差异；插件不得加入模型专属 Prompt 改写。
- 若实际服务端模型 revision 无法解析，manifest 必须记录 unresolved，不能宣称跨时间完全可复现。

### 6.4 指纹与规范化

所有结构化指纹必须包含 schemaVersion，并使用确定性的 canonical JSON 序列化，例如 RFC 8785；对象键顺序、数组顺序、数字和空值处理必须固定。Prompt 与系统提示词按原始 UTF-8 字节计算，不做 trim 或换行规范化。二进制附件不进入 JSON 正文，而以 ordinal、MIME、byteSize 和 SHA-256 的有序记录参与计算。

- taskPackageHash：覆盖 Adapter 之前的逻辑任务输入，包括 Task 元数据、Prompt 原始字节、有序附件源 hash 和 workspace baseline hash。
- resolvedHarnessFingerprint：覆盖实际解析后的系统提示词、Agent Loop 实现与版本、工具 schema、工具描述、权限、sandbox、上下文与记忆策略、DSH 版本及相关插件版本。只保存 Harness Profile 名称不够。
- executionConditionsHash：覆盖公共执行限制、调度策略、超时、Watchdog、取消策略和低层 Retry 策略。
- modelConfigFingerprint：每个 Run 独立计算，覆盖稳定 modelConfigId、Provider、Model、非敏感配置、已解析 revision 和 Adapter 版本。
- inputFingerprint：Attempt dispatch 前由 taskPackageHash 与 resolvedHarnessFingerprint 组合得到，表示模型应看到的逻辑内容和固定 Harness 条件。
- effectiveInputHash：若 DSH 可以观测 Adapter 后的语义输入，则额外记录。base64、multipart 等无损协议封装不进入该 hash；缩放、重压缩、裁剪、转码、OCR 或 Prompt 改写必须改变该 hash 并触发公平性阻断。
- experimentFingerprint：覆盖 Task Package、Resolved Harness、Execution Conditions、全部 modelConfigFingerprint 和版本信息。

每个 Attempt 在 dispatch 前必须重新解析并验证 taskPackageHash、resolvedHarnessFingerprint、executionConditionsHash 和所属 Run 的 modelConfigFingerprint。任何漂移都必须以明确错误码阻止，不得继续或静默使用新版本。

---

## 7. 页面结构

V1 只需要三种视图，避免重复页面和状态同步复杂性。

### 7.1 Model PK 创建页

页面区域按顺序为：

1. 标题与 V1 评测口径说明。
2. Task Name。
3. Task Type：Coding、Reasoning、Writing、Analysis、Other；仅作标签。
4. 模型选择器。
5. 统一 Prompt 输入区。
6. 多图片附件区。
7. Workspace Baseline 区。
8. Concurrency。
9. Fair Mode 与实际输入摘要。
10. Run Preflight。
11. Start PK。

### 7.2 Preflight 面板

可以是创建页内嵌面板或对话框，但必须同时展示：

- 全局检查结果。
- 每个模型的独立检查结果。
- 最终 Prompt 预览。
- 图片数量、顺序、文件名、MIME、大小和短 hash。
- workspace baseline 引用和 hash。
- 固定系统提示词、Harness Profile、工具集与权限摘要。
- 公共执行参数、并发数、超时和卡死阈值。
- DSH、插件和 Adapter 版本。
- Provider 固有差异或无法验证项。

### 7.3 Experiment 详情页

运行态与结果态使用同一页面，自然从 ACTIVE 过渡到 SETTLED。页面包含：

- 实验标题、ID、总体状态和公平性摘要。
- Running、Queued、Finished 计数。
- Stop All。
- Retry Failed。
- Open Experiment Folder。
- 按用户选择顺序排列的 N 个 Run 卡片或可扩展列表。
- 原始输出对照区；只展示，不评分、不排序。

每个 Run 卡片至少显示：

- 模型显示名、Provider、Model ID。
- 最新 Attempt 编号。
- 状态和结构化原因。
- 排队时间、开始时间、运行时长、最后有效活动时间。
- 当前输出或最近事件摘要。
- View Details、Stop、Retry 或 Run Again。

Run 详情固定包含以下标签：

- Output
- Live Log
- Transcript
- Attempts
- Artifacts
- Metadata

N 较大时应使用响应式卡片或列表，不应强行平均挤成 N 列。模型顺序在整个 Experiment 生命周期内保持不变。

---

## 8. 核心用户流程

### 8.1 创建并开始 PK

~~~text
进入 Model PK
→ 填写 Task Name
→ 选择 Task Type
→ 从 DSH 列表选择至少 2 个模型
→ 输入统一 Prompt
→ 可选：添加并调整多张图片顺序
→ 选择或确认 workspace baseline
→ 设置并发数
→ 查看实际输入摘要
→ Run Preflight
→ 当前输入对应的检查完成
→ 全局 READY，或所有 WARNING 已明确确认
→ Start PK
→ 以 startActionId 提交冻结操作
→ 逻辑原子地创建 Experiment、N 个 Run、N 个首个 Attempt 与入队意图
→ 按并发限制进入 QUEUED / PREPARING / DISPATCHING / RUNNING
~~~

Start 前允许编辑。任何会影响实验的编辑都会使既有 Preflight 立即失效。Start 后 Task Package、模型集合和 Execution Conditions 全部只读。

Start PK 必须幂等。manifest、Run、INITIAL Attempt 与入队意图属于同一个逻辑提交；不能让用户看到只有部分 Run 的 Experiment。若文件系统无法跨文件原子提交，必须先在 Durable Control Store 中事务提交并使用 commit marker 完成归档投影。重复 startActionId 返回同一个 Experiment；相同 ID 携带不同内容则报冲突。

### 8.2 添加图片

用户可以通过文件选择、拖拽或粘贴截图添加图片。每张图显示缩略图、编号、文件名、格式、大小、上传状态和删除操作；Start 前可调整顺序。

粘贴普通文本时不得被图片处理逻辑拦截。剪贴板含图片时添加附件。支持的格式、数量和大小限制必须直接继承并展示 DSH 的实际限制，前端和运行端不得各自维护不同规则。

每个附件状态为 UPLOADING、READY 或 FAILED。只有所有保留附件均为 READY，且不可变引用和 SHA-256 已生成时，才允许 Preflight。FAILED 附件必须被成功删除或重新上传，不能被冻结进 Task Package。

### 8.3 Preflight

Preflight 不创建 Attempt，也不发送用户任务 Prompt。它只验证当前快照能否可靠运行。任一硬阻断项存在时，所有模型均不得开始；V1 不提供“先跑可用模型”的隐式降级。

Start PK 只有在“当前 taskPackageHash、resolvedHarnessFingerprint、executionConditionsHash 和模型集合”对应的 Preflight 已完成，且结果为 READY，或 WARNING 已被用户对该快照明确确认时才启用。NOT_CHECKED、CHECKING、BLOCKED 以及未确认 WARNING 一律禁用 Start。任何相关编辑都会同时清除 WARNING 确认。

### 8.4 实时观察

用户在一个页面中观察 N 个 Run。事件到达后更新状态、流式输出、最后活动时间和日志。刷新页面或 UI 临时断线不得改变后端 Attempt 状态；重连后从持久化游标补齐事件。

### 8.5 单路 Stop 与 Stop All

- Stop 只作用于目标 Run 的当前非终态 Attempt。
- Stop All 只取消当前所有非终态 Attempt。
- 已成功、已失败或已归档结果不得删除。
- 已处于 CANCELLING 的 Attempt 对重复 Stop 幂等返回。
- 取消过程必须先进入 CANCELLING；如果模型完成、失败或超时事件先原子提交，则该真实终态获胜。取消失败时按第 11 节恢复为 RUNNING、进入 RECOVERING 或以明确错误结束。

### 8.6 单路 Retry

Retry 面向最新 Attempt 处于 FAILED、TIMED_OUT、STALLED、DISCONNECTED 或 CANCELLED 的单个 Run。它：

1. 校验 modelConfigFingerprint、taskPackageHash、resolvedHarnessFingerprint 和 executionConditionsHash。
2. 创建下一个 Attempt。
3. 创建全新的独立 workspace。
4. 从同一 workspace baseline 重新物化输入。
5. 重新进入统一并发队列。
6. 保留旧 Attempt 与全部旧产物。

非可重试配置错误必须禁用 Retry，并显示原因。

### 8.7 成功单路 Run Again

Run Again 面向最新 Attempt 已 SUCCEEDED 的单个 Run，用于观察同一模型在相同条件下的结果差异。它创建同一 Run 下的新 Attempt，不创建新 Experiment，不修改 Task Package，也不覆盖旧结果。

### 8.8 Retry Failed

Retry Failed 在点击瞬间冻结目标集合，只为最新 Attempt 处于以下状态且可重试的 Run 各创建一个新 Attempt：

- FAILED
- TIMED_OUT
- STALLED
- DISCONNECTED

默认不包含 SUCCEEDED、CANCELLED、不可重试失败或当前已有活动 Attempt 的 Run。界面必须在确认前显示将重试几路、跳过几路及跳过原因。

### 8.9 幂等规则

- 同一个 Run 同一时刻最多有一个非终态 Attempt。
- Start、Retry、Run Again、Retry Failed、Stop 和 Stop All 必须使用幂等操作 ID。
- 双击按钮、网络重复提交或页面恢复不得产生重复 Attempt。
- Durable Action 记录至少保存 operationId、type、experimentId、requestHash、frozenTargets、status 和 result。相同 operationId 携带不同 requestHash 必须返回 ACTION_ID_CONFLICT。
- 创建新 Attempt 时必须以 latestAttemptId 做 compare-and-set，并硬性保证每个 Run 最多一个非终态 Attempt。单路操作与批量操作竞争时只允许一个成功，另一方返回 ACTION_TARGET_STALE。
- Retry Failed 在一个控制存储事务中为冻结目标集合全部创建 Attempt；任一目标在提交前变为 stale 时，本次批量操作全部不创建，并要求用户重新确认，禁止半批成功。
- V1 不进行任务级自动 Retry，以免掩盖稳定性问题和额外费用。

---

## 9. 功能需求

### FR-001：读取 DSH 模型列表

- 插件必须从 DSH 模型注册表读取已配置且可选的模型。
- 列表必须支持刷新，并反映 DSH 配置新增、删除和失效。
- 每项至少显示配置显示名、Provider、Model ID、图片能力和可用性状态。
- 选择器必须有 LOADING、READY、EMPTY、ERROR 和 REFRESHING 状态；EMPTY 与 ERROR 均提供可行动说明，ERROR 提供 Retry。
- 刷新后若已选配置被删除或失效，必须保留该选择并标为 invalid，而不是静默移除；同时使 Preflight 失效，直到用户移除或恢复配置。
- 插件不得维护静态模型名单。

### FR-002：模型多选

- 用户必须至少选择 2 个不同 modelConfigId 才能进入 Preflight。
- 模型按 Provider 分组，并支持搜索与清空选择。
- 同一配置项不得重复。
- 用户选择顺序同时决定 Run 展示顺序和初始排队顺序。
- 不允许逐模型输入不同 Prompt、图片或公共执行参数。

### FR-003：统一 Prompt

- Prompt 为必填。
- 必须保存用户原始 UTF-8 内容，不自动 trim、改写、补全或规范化换行。
- 所有 Run 使用同一 Prompt 引用和 hash。
- Start 前提供最终实际输入预览。

### FR-004：多图片输入

- 必须支持文件选择、多图拖拽和从剪贴板粘贴。
- 必须支持缩略图、UPLOADING / READY / FAILED 单项状态、删除、重试和顺序调整。
- 每个附件记录 ordinal、原文件名、MIME、大小、SHA-256 和不可变引用。
- 不得静默压缩、转码、OCR、去除或重排。
- 上传失败必须针对单项显示具体错误。
- 只有所有保留附件均 READY，且 hash 与不可变引用已落盘时，Preflight 才能开始。

### FR-005：Workspace Baseline

- V1 支持空 workspace 基线和 DSH 当前任务 workspace 的不可变快照两种逻辑模式；实际可用模式由 DSH 正式能力决定。
- snapshot 必须在 Experiment 冻结前创建并计算 hash。
- snapshot 规则必须记录是否包含隐藏文件、依赖目录、Git 元数据和符号链接。
- 不得跟随指向允许根目录之外的符号链接。
- snapshot 实体必须复制或内容寻址地纳入 Experiment 拥有且享受垃圾回收豁免的存储；只保存可能被清理的临时外部引用不满足 V1。
- 每个 Attempt 从同一 baseline 创建全新目录，不能复用或清空旧目录。

### FR-006：固定 DSH Harness Profile

- 所有 Run 使用同一 Agent Loop、系统提示词、工具集、工具描述和权限策略。
- Harness Profile 在 V1 不允许逐模型修改。
- DSH 原生工具若启用，必须被限制在当前 Attempt workspace 和一致权限内。
- 不允许调用任何外部 CLI Agent 或 Agent Router。

### FR-007：Preflight

Preflight 至少检查：

- DSH 连接与版本兼容性。
- modelConfigId 仍存在且未漂移。
- Provider 已配置。
- 鉴权有效，若 DSH 支持无任务健康检查。
- Provider 和模型当前可用，或明确显示无法验证的 WARNING。
- 模型支持 Task Package 所需输入模态。
- 图片格式、数量、大小和上下文限制可接受。
- 公共参数、输出上限和超时策略可被执行。
- workspace baseline 可读取并可物化。
- 实验与归档目录可写。
- 固定 Harness Profile 与 Adapter 可用，且可解析 resolvedHarnessFingerprint。

Preflight 状态为 NOT_CHECKED、CHECKING、READY、WARNING、BLOCKED。Start PK 仅在当前指纹对应的检查已完成并为 READY，或全部 WARNING 已对当前快照明确确认时启用。NOT_CHECKED、CHECKING、BLOCKED 和未确认 WARNING 一律禁用。任何 Task Package、模型、Resolved Harness 或执行配置变化都会令结果与 WARNING 确认失效。

### FR-008：实验冻结与 Manifest

- Start PK 必须携带 startActionId，并在 Durable Control Store 中逻辑原子地提交 Experiment、N 个 Run、N 个 INITIAL Attempt 和入队意图。
- Start PK 前必须写入 experiment.json、Task Package 快照和 commit marker；所有归档定义成功发布前，零 Attempt 可以 dispatch。
- 冻结后不得修改 Prompt、附件、模型集合、baseline 或公共执行条件。
- 若 manifest 写入失败，零 Attempt 可以 dispatch。
- 每个 Experiment 使用稳定 UUID 和安全 slug，显示名不能作为唯一身份。
- 重复 startActionId 必须返回同一个结果；相同 ID 携带不同请求必须返回 ACTION_ID_CONFLICT。
- 启动中崩溃后必须完成原提交或进入 START_FAILED，不得留下可运行的部分 Experiment，也不得重复创建 Run。

### FR-009：N 模型运行与并发

- 每个选中模型创建一个独立 Run。
- 每个 Run 的初始 Attempt 进入同一个全局实验队列。
- Concurrency 范围为 1 到 min(N, DSH 后端安全上限)，默认 min(4, N)。
- 并发槽从进入 PREPARING 开始占用，覆盖 DISPATCHING、RUNNING、RECOVERING 和 CANCELLING，直到底层执行确认终止或写 lease 已撤销并完成隔离。
- 任意时刻占用并发槽的 Attempt 数不得超过 Concurrency。
- 队列采用全局 FIFO。初始 Attempt 按 Run ordinal 入队；单路重跑追加到队尾；批量重跑在同一批内按 Run ordinal 排序后整体追加到队尾。V1 不抢占、不插队。
- QUEUED 等待时间不计入硬执行超时。
- 首次运行与所有重跑共用同一并发额度，不得绕过调度器。

### FR-010：实时状态与日志

- UI 必须展示每路状态、Attempt 编号、运行时长、最后有效活动和输出摘要。
- 日志必须带单调序号与时间戳，支持自动滚动暂停和复制。
- UI 可以虚拟化长日志，但磁盘归档不得因 UI 截断。
- Token、成本、首 token 延迟和 Provider request ID 仅在 DSH 可可靠提供时展示；缺失显示为不可用，不得猜测。

### FR-011：Watchdog

- 每个 Attempt 维护 workerHeartbeatAt 与 lastProgressAt，两者不得混用。
- 有效进展包括模型输出片段、模型完成消息、工具调用、工具结果、受控文件操作或 DSH 明确进度事件。
- 仅有进程 heartbeat 不能证明模型产生进展。
- 建议 V1 默认值：3 分钟无进展显示 NO_PROGRESS_WARNING，5 分钟无进展终止并进入 STALLED，30 分钟达到硬执行超时并进入 TIMED_OUT，取消宽限期 10 秒。
- 这些有效值必须写入 Execution Conditions；最终数值应在 DSH 集成测试后冻结。
- 达到 STALLED 后不得自动 Retry。

### FR-012：取消

- QUEUED Attempt 可直接取消，且不得向 Provider dispatch。
- PREPARING、DISPATCHING、RUNNING 或 RECOVERING Attempt 接受 Stop 后进入 CANCELLING；已是 CANCELLING 时幂等返回。
- 宽限期内完成底层取消则进入 CANCELLED；必要时执行受控强制终止并撤销写 lease。
- CANCELLING 期间先到达的真实完成、失败、超时、卡死或掉线终态可以通过原子 compare-and-set 获胜。
- 取消命令失败但执行仍被确认健康时，Attempt 回到 RUNNING 并记录 CANCEL_FAILED Action；无法确认时进入 RECOVERING，最终恢复或 DISCONNECTED；取消失败同时终止 Runner 时可进入 FAILED + CANCEL_FAILED。
- 完成与取消竞态以第一个原子写入的终态为准。
- 迟到事件不得改变终态，只能进入诊断日志。

### FR-013：重跑

- Retry、Run Again 和 Retry Failed 均只新增 Attempt。
- 新 Attempt 必须复用并校验相同 modelConfigFingerprint、taskPackageHash、resolvedHarnessFingerprint 和 executionConditionsHash。
- 新 Attempt 必须使用新的 session 和全新 workspace。
- 每个 Attempt 获得唯一 executionLeaseId 与 fencingToken；终态提交和并发槽释放前必须撤销旧写 lease。旧 Worker 的迟到写入由 storage 层拒绝并进入独立诊断通道。
- 若无法确认旧执行已终止，但已成功撤销写 lease并隔离 workspace，可以允许重跑，但必须显示 executionTerminationConfirmed=false 与可能继续计费的警告；无法完成隔离时禁止重跑。
- 重跑入口不得允许修改任何冻结字段。
- 历史 Attempt 目录不得覆盖。

### FR-014：独立结果与产物

- 每个 Attempt 必须有独立 workspace、artifacts、result、metadata、transcript 和日志位置。
- 一个 Run 的失败不得终止、删除或污染其他 Run。
- 结果页面默认显示最新 Attempt，并明确显示 Attempt X of Y。
- 用户可以切换查看所有历史 Attempt。

### FR-015：一键打开目录

- Experiment 目录创建成功后启用 Open Experiment Folder。
- 必须使用已规范化和校验的准确实验根目录调用本机文件管理器。
- 目录丢失、权限不足或打开失败时，显示具体错误并提供 Copy Path。
- 不得静默新建空目录冒充原实验目录。
- V1 首发验收平台为 macOS，目标文件管理器为 Finder；Windows 与 Linux 不属于 V1 发布门禁。

### FR-016：页面与进程恢复

- 浏览器刷新、UI 关闭或前端连接中断不改变后端 Attempt 状态。
- 重连后按事件游标补齐状态和日志，不重复、不丢失。
- 宿主进程重启后，不得无条件重新提交旧 Attempt。
- dispatch 前必须持久化 dispatchIntentId、idempotencyKey 和 dispatchIntentAt；收到 DSH 或 Provider 接受确认后写 dispatchAckAt 与 dshSessionId。
- 若 DSH 支持幂等键或按键查询，恢复时必须查询并续接原请求。若不支持，处于“已发送但 ACK 未落盘”窗口的 Attempt 不得自动重发，而是进入 RECOVERING，最终以 DISCONNECTED + RECOVERY_UNRESOLVED 结束。
- QUEUED 在重启后保持队列语义；PREPARING、DISPATCHING、RUNNING 与 CANCELLING 均必须有合法 RECOVERING 路径和固定 recovery deadline。
- 若 DSH 支持 session 恢复则续接；无法确认的 Attempt 最终明确恢复或以 DISCONNECTED 结束，不能永久停在 RUNNING。

---

## 10. 数据结构契约

### 10.1 关系

~~~text
Experiment
├── Task Package（不可变）
├── Execution Conditions（不可变）
├── Model Config Snapshots（不可变）
└── Runs[1..N]
    └── Run（一个 modelConfigId）
        └── Attempts[1..M]
            ├── Attempt 1：INITIAL
            ├── Attempt 2：RETRY / RUN_AGAIN / RETRY_FAILED
            └── Attempt M
~~~

### 10.2 Experiment 不可变定义字段

| 字段 | 说明 |
|---|---|
| schemaVersion | Manifest schema 版本 |
| experimentId | 稳定 UUID |
| name / taskType | 展示信息与标签 |
| taskPackage | 冻结任务输入 |
| taskPackageHash | Task Package 指纹 |
| resolvedHarness | 实际解析的 Harness 快照 |
| resolvedHarnessFingerprint | Harness 指纹 |
| executionConditions | 冻结公共执行条件 |
| executionConditionsHash | 执行条件指纹 |
| experimentFingerprint | 完整实验指纹 |
| selectedModels | 有序模型配置快照 |
| preflightSnapshot | 启动前检查结果与时间 |
| dshVersion / pluginVersion | 版本信息 |
| createdAt / frozenAt | 时间 |
| experimentPath | 规范化实验根目录 |
| stateRef / eventsRef | 可变投影与事件引用 |

experiment.json 只保存冻结事实，不包含 lifecycleState 或 outcome。

### 10.3 Run 不可变定义字段

| 字段 | 说明 |
|---|---|
| runId | 稳定 UUID |
| experimentId | 所属 Experiment |
| ordinal | 用户选择顺序 |
| modelConfigSnapshot | 冻结 Provider 与 Model 配置 |
| modelConfigFingerprint | 模型配置指纹 |
| createdAt | Run 创建时间 |

run.json 只保存稳定参赛席位，不包含 latestAttemptId、derivedState 或 attemptCount。

### 10.4 Attempt 最小字段

| 字段 | 说明 |
|---|---|
| attemptId / attemptNo | 稳定身份与单调序号 |
| runId | 所属 Run |
| trigger | INITIAL、RETRY、RUN_AGAIN、RETRY_FAILED |
| batchActionId | 批量操作关联，可空 |
| state | Attempt 生命周期状态 |
| taskPackageHash | 输入一致性校验 |
| resolvedHarnessFingerprint | 固定 Harness 一致性校验 |
| executionConditionsHash | 执行条件一致性校验 |
| modelConfigFingerprint | 本 Run 模型配置校验 |
| inputFingerprint | 模型可见输入与基线指纹 |
| effectiveInputHash | Adapter 后语义输入指纹，可空 |
| dispatchIntentId / idempotencyKey | dispatch 恢复与防重 |
| dshSessionId | DSH session 引用 |
| providerRequestId | 可用时记录 |
| queuedAt / preparingAt / dispatchIntentAt / dispatchAckAt | 启动时序 |
| startedAt / endedAt | 执行时序 |
| firstOutputAt / lastProgressAt / workerHeartbeatAt | 观察指标 |
| executionLeaseId / fencingToken | 底层写入栅栏 |
| executionTerminationConfirmed | 是否确认底层终止 |
| workspacePath / artifactPath | 独立目录 |
| logRef / transcriptRef / metadataRef | 归档引用 |
| finalResponseRef | 最终文本结果 |
| archiveCompleteness | COMPLETE、PARTIAL 或 INCOMPLETE |
| error | 结构化错误，可空 |
| cancelReason | 取消原因，可空 |

Attempt 运行期间的 metadata.json 是由 Durable Control Store 与事件生成的原子替换投影；进入终态并完成 finalization commit 后冻结。终态、输入指纹、错误和已发布产物引用不得再改写。迟到事件只追加到隔离诊断通道。

### 10.5 可变状态投影

state.json 只保存可重建的当前投影，至少包括：

- Experiment lifecycleState 与 outcome。
- 每个 Run 的 latestAttemptId、lastSuccessfulAttemptId、derivedState 和 attemptCount。
- Running、Queued、Finished 计数。
- 当前活动 Action 与恢复提示。

删除 state.json 后，必须可以从不可变定义、Durable Control Store 和有序事件重建相同投影。

### 10.6 Durable Control Store

V1 必须有一个独立于实验归档目录的最小耐久控制存储。可使用 SQLite 或提供等价事务、唯一约束和崩溃恢复能力的实现。它是运行期间以下信息的事实来源：

- Start 与所有用户 Action 的幂等记录。
- Experiment、Run、Attempt 身份及最新状态。
- 每个 Run 最多一个非终态 Attempt 的约束。
- dispatch intent、ACK、session 引用和恢复截止时间。
- execution lease、fencing token 与并发槽。
- 终态和 archiveCompleteness。

experiment.json 与 run.json 是冻结定义的事实来源；Durable Control Store 是运行控制状态的事实来源；events.jsonl 是追加式审计导出；state.json 和 metadata.json 是可重建投影。四者职责不得混用。

---

## 11. 状态机

### 11.1 Attempt 状态

| 状态 | 类型 | 含义 |
|---|---|---|
| QUEUED | 非终态 | 已持久化，等待并发名额 |
| PREPARING | 非终态 | 正在创建 session、物化 workspace 与校验输入 |
| DISPATCHING | 非终态 | dispatch intent 已持久化，等待 DSH 接受确认 |
| RUNNING | 非终态 | 已收到 dispatch ACK，执行中 |
| RECOVERING | 非终态 | 宿主恢复后正在确认原执行状态 |
| CANCELLING | 非终态 | 已接受取消，等待底层确认或强制终止 |
| SUCCEEDED | 终态 | 模型完成且关键归档落盘成功 |
| FAILED | 终态 | 一般执行失败，具体原因见 error.code |
| TIMED_OUT | 终态 | 超过硬执行时限 |
| STALLED | 终态 | 在硬时限内连续超过卡死阈值无有效进展 |
| DISCONNECTED | 终态 | Worker 或 Provider 执行通道在宽限期后不可恢复 |
| CANCELLED | 终态 | 用户单路 Stop、Stop All 或受控强制取消 |

### 11.2 状态转换

~~~text
QUEUED
├──→ PREPARING
└──→ CANCELLED

PREPARING
├──→ DISPATCHING
├──→ FAILED
├──→ RECOVERING
└──→ CANCELLING

DISPATCHING
├──→ RUNNING
├──→ FAILED
├──→ RECOVERING
└──→ CANCELLING

RUNNING
├──→ SUCCEEDED
├──→ FAILED
├──→ TIMED_OUT
├──→ STALLED
├──→ DISCONNECTED
├──→ RECOVERING
└──→ CANCELLING

CANCELLING
├──→ CANCELLED
├──→ RUNNING
├──→ RECOVERING
└──→ SUCCEEDED / FAILED / TIMED_OUT / STALLED / DISCONNECTED

RECOVERING
├──→ PREPARING / DISPATCHING / RUNNING / CANCELLING
└──→ SUCCEEDED / FAILED / TIMED_OUT / STALLED / DISCONNECTED / CANCELLED
~~~

规则：

1. 每个 Attempt 只能原子写入一次终态。
2. QUEUED 等待时间不计入硬执行超时。
3. 硬执行超时从 dispatch ACK 或可证明 Provider 已接受请求时开始。
4. workspace 准备应有独立准备超时，失败映射为 FAILED。
5. UI 与 DSH 的前端连接中断不等于 DISCONNECTED，后端 Attempt 继续运行。
6. Provider 或 Worker 执行通道不可恢复才是 DISCONNECTED。
7. STALLED 前应先出现 NO_PROGRESS_WARNING 健康标记；健康标记不是生命周期状态。
8. 进入任何终态并释放并发槽前，Runner 必须撤销 execution lease 或确认终止；该 Attempt 的 workspace 随后只属于原 Attempt，持有旧 fencing token 的迟到写入会被 storage 拒绝。
9. 成功响应但关键 metadata、transcript 或 manifest 无法完成落盘时，不得标为 SUCCEEDED。
10. PREPARING、DISPATCHING、RUNNING 与 CANCELLING 在宿主重启后均可进入 RECOVERING；QUEUED 保持排队且不重复创建。
11. RECOVERING 必须有写入 Execution Conditions 的 recovery deadline。到期仍无法确认时进入 DISCONNECTED + RECOVERY_UNRESOLVED，不能无限等待。
12. CANCELLING 时若真实终态先通过 compare-and-set 提交，则真实终态获胜；取消失败但执行仍健康时可以返回 RUNNING。

### 11.3 Run 派生状态

- Run 尚无 Attempt 时为 NOT_STARTED。
- Run 有非终态 Attempt 时，展示该 Attempt 的状态。
- 否则展示最新 Attempt 的终态。
- 历史成功不被删除；若成功后的 Run Again 失败，Run 最新状态显示失败，同时保留 lastSuccessfulAttemptId。
- UI 不自动选择“最佳 Attempt”，因为 V1 不做 Judge。

### 11.4 创建页状态、Experiment 生命周期与结果

DRAFT、PREFLIGHTING、PREFLIGHT_BLOCKED、READY 与 WARNING 是 Experiment 创建页状态，不是已持久化 Experiment 生命周期。只有用户以 startActionId 提交 Start 后才创建 Experiment。

持久化 Experiment 生命周期：

~~~text
STARTING
├──→ ACTIVE
└──→ START_FAILED

ACTIVE
├──→ SETTLED
└──→ CANCELLING → SETTLED

SETTLED --Retry / Run Again / Retry Failed→ ACTIVE
~~~

STARTING 表示控制存储已提交 Start 意图、正在发布完整冻结定义。进入 ACTIVE 前不得 dispatch。START_FAILED 必须保证没有任务执行请求。

SETTLED 仅表示当前没有非终态 Attempt。聚合 outcome 独立计算：

- ALL_SUCCEEDED：每个 Run 最新 Attempt 均成功。
- PARTIAL_SUCCESS：至少一路成功，至少一路非成功。
- NONE_SUCCEEDED：没有成功，且至少一路非取消终态。
- ALL_CANCELLED：全部 Run 最新 Attempt 均取消。

不得因为一路失败就把整个 Experiment 简化显示为 FAILED。

---

## 12. 错误模型与错误码

### 12.1 结构化错误

每个错误至少包含：

~~~text
error:
  code
  phase
  retryable
  userMessage
  technicalMessage
  providerCode
  providerRequestId
  occurredAt
~~~

phase 只能是：

- START
- ACTION
- PREFLIGHT
- PREPARE
- DISPATCH
- STREAM
- FINALIZE
- CANCEL
- RECOVERY

technicalMessage 必须脱敏。UI 默认展示 userMessage、code 和是否可重试；技术详情放在可展开区域。

### 12.2 Preflight 阻断码

| 错误码 | 默认可重试 | 含义 |
|---|---:|---|
| DSH_UNREACHABLE | 是 | 无法连接 DSH 宿主能力 |
| DSH_VERSION_UNSUPPORTED | 否 | DSH 版本不在插件兼容范围 |
| MODEL_CONFIG_NOT_FOUND | 否 | 冻结或选中的配置不存在 |
| MODEL_CONFIG_DRIFT | 否 | 配置已变化，无法保证原条件 |
| HARNESS_PROFILE_DRIFT | 否 | Agent Loop、系统提示词、工具或权限已漂移 |
| RUNTIME_VERSION_DRIFT | 否 | DSH 或插件版本无法复现冻结条件 |
| ADAPTER_VERSION_DRIFT | 否 | Provider Adapter 版本已变化 |
| PROVIDER_NOT_CONFIGURED | 否 | Provider 未配置 |
| PROVIDER_AUTH_FAILED | 否 | 鉴权失败 |
| PROVIDER_UNAVAILABLE | 是 | Provider 暂时不可用 |
| MODEL_UNAVAILABLE | 是 | 模型暂时不可用 |
| IMAGE_INPUT_UNSUPPORTED | 否 | 任务有图片但模型不支持 |
| ATTACHMENT_INVALID | 否 | 图片格式、大小、数量或内容无效 |
| INPUT_TOO_LARGE | 否 | 输入超过能力限制 |
| PARAMETER_UNSUPPORTED | 否 | 公共强制参数不受支持 |
| HARNESS_PROFILE_UNAVAILABLE | 否 | 固定 DSH Harness Profile 不可用 |
| WORKSPACE_NOT_READABLE | 否 | baseline 无法读取 |
| ARCHIVE_NOT_WRITABLE | 否 | 实验目录无法安全写入 |
| PREFLIGHT_UNVERIFIED | 是 | 无法验证实时可用性；作为 WARNING 而非 BLOCKED |

### 12.3 运行期错误码

| 错误码 | 典型状态 | 默认可重试 |
|---|---|---:|
| ATTACHMENT_MISSING | FAILED | 否 |
| ATTACHMENT_HASH_MISMATCH | FAILED | 否 |
| ATTACHMENT_CONTENT_TRANSFORMED | FAILED | 否 |
| WORKSPACE_PREPARE_FAILED | FAILED | 视原因 |
| WORKSPACE_NOT_CLEAN | FAILED | 否 |
| PROVIDER_RATE_LIMITED | FAILED | 是 |
| PROVIDER_ERROR | FAILED | 是 |
| PROVIDER_5XX | FAILED | 是 |
| INVALID_REQUEST | FAILED | 否 |
| UNSUPPORTED_INPUT | FAILED | 否 |
| CONTENT_POLICY_REJECTED | FAILED | 否 |
| INVALID_PROVIDER_RESPONSE | FAILED | 视原因 |
| EMPTY_RESPONSE | FAILED | 是 |
| ADAPTER_ERROR | FAILED | 视原因 |
| DSH_RUNNER_ERROR | FAILED | 视原因 |
| PROCESS_EXITED | FAILED | 视原因 |
| DISPATCH_UNCERTAIN | RECOVERING | 是 |
| STREAM_DISCONNECTED | DISCONNECTED | 是 |
| WORKER_DISCONNECTED | DISCONNECTED | 是 |
| STALL_TIMEOUT | STALLED | 是 |
| EXECUTION_TIMEOUT | TIMED_OUT | 是 |
| ARCHIVE_WRITE_FAILED | FAILED | 否 |
| DISK_FULL | FAILED | 否 |
| CANCEL_FAILED | RUNNING、RECOVERING 或 FAILED | 是 |
| RECOVERY_UNRESOLVED | DISCONNECTED | 是 |
| START_COMMIT_FAILED | START_FAILED | 是 |
| ACTION_ID_CONFLICT | 原状态不变 | 否 |
| ACTION_TARGET_STALE | 原状态不变 | 是 |
| INTERNAL_ERROR | FAILED | 视原因 |

### 12.4 取消原因

CANCELLED 不是一般错误。cancelReason 为：

- USER_CANCELLED
- STOP_ALL
- FORCE_CANCELLED_AFTER_GRACE

### 12.5 错误处理原则

- 不允许把所有异常都显示为 Unknown Error。
- Provider 原始错误必须映射到稳定插件错误码，同时保留脱敏后的 providerCode。
- Provider 限流、网络掉线或服务故障不得自动解释为模型能力不足。
- 任何静默 fallback 都被禁止。
- 单路错误不能中止其他 Run。
- 错误码映射必须有单元测试，并对未知 Provider 错误使用 INTERNAL_ERROR 或 PROVIDER_ERROR，同时保留诊断信息。

---

## 13. 归档与实验目录

### 13.1 运行数据根目录

实际实验数据目录不应放在插件源码仓库内。最终根目录由 DSH 正式插件数据目录约定决定，并在设置或 manifest 中记录。下面是逻辑布局，物理根路径可以适配 DSH。

~~~text
experiments/
└── 2026-08-17/
    └── <experiment-id>-<safe-task-slug>/
        ├── experiment.json
        ├── state.json
        ├── events.jsonl
        ├── task-package/
        │   ├── task-package.json
        │   ├── prompt.md
        │   ├── attachments/
        │   │   ├── index.json
        │   │   ├── 001-<sha256>.<ext>
        │   │   └── 002-<sha256>.<ext>
        │   └── workspace-baseline/
        │       ├── manifest.json
        │       └── snapshot/ 或 Experiment 自有内容寻址对象
        └── runs/
            └── <run-ordinal>-<safe-model-slug>-<run-id>/
                ├── run.json
                └── attempts/
                    └── 0001-<attempt-id>/
                        ├── metadata.json
                        ├── effective-input.redacted.json
                        ├── effective-attachments.json
                        ├── transcript.jsonl
                        ├── events.jsonl
                        ├── logs.jsonl
                        ├── result.md
                        ├── error.json
                        ├── artifacts/
                        └── workspace/
~~~

### 13.2 文件职责

- experiment.json：不可变 Experiment manifest、模型快照和版本信息。
- state.json：可由事件重建的当前聚合状态，使用原子替换。
- events.jsonl：实验级有序状态事件。
- task-package.json：冻结的 Task Package、指纹和公共执行条件引用。
- prompt.md：用户 Prompt 的易读副本，不得改变原文。
- attachments/index.json：有序附件清单、MIME、大小、hash 和 DSH 引用。
- workspace-baseline：Experiment 自有、可在外部原 workspace 不存在时独立物化的 baseline 实体；若使用全局内容寻址存储，必须由 Experiment 持有保留引用并免受垃圾回收。
- run.json：一个模型参赛席位与模型配置快照。
- metadata.json：Attempt 时序、状态、错误、参数、request ID、archiveCompleteness 与指标；运行中是投影，终态提交后冻结。
- effective-input.redacted.json：实际可观察的系统输入、用户输入、附件引用和 Adapter 信息；必须脱敏。
- effective-attachments.json：逐附件记录 sourceHash、effectiveContentHash、无损封装或内容转换链、Adapter 版本及可验证性。
- transcript.jsonl：DSH 会话消息、模型输出、工具调用和工具结果的完整有序记录。
- logs.jsonl：Runner、调度、状态转换和诊断日志。
- result.md：模型最终文本输出；一般失败时可以不存在但应有 error.json。若归档目录本身不可写，错误终态由 Durable Control Store 保证，允许 error.json 缺失并标记 archiveCompleteness=INCOMPLETE。
- artifacts：模型或工具产生的用户产物。
- workspace：该 Attempt 的独立工作目录或完成快照。

### 13.3 归档规则

1. experiment.json、全部 run.json 和 Start commit marker 必须在任何任务 dispatch 前成功发布；发布后其 hash 在运行、Retry 和 Cancel 前后保持不变。
2. Attempt ID、dispatch intent、幂等键和目录必须在 dispatch 前写入 Durable Control Store，防止崩溃后重复提交。
3. 日志、transcript 和事件采用追加写，并带单调序号。
4. 旧 Attempt 永不覆盖。
5. 目录名只使用安全 slug 和稳定 ID，不能直接信任模型名或 Provider 返回的路径。
6. 实验文件默认仅当前本机用户可读写。
7. API Key、Authorization Header、Cookie、签名 URL 和敏感环境变量不得进入归档。
8. Transcript 可能包含用户数据或模型回显内容；UI 必须提示本地归档风险，不能承诺通用脱敏能消除所有秘密。
9. finalization commit 顺序为：在临时路径完成并校验关键文件，原子发布文件，向 Durable Control Store 提交终态，再更新 state.json 和导出事件。
10. 归档失败必须在独立 Durable Control Store 中记录 FAILED + ARCHIVE_WRITE_FAILED 或 DISK_FULL，并设置 archiveCompleteness=PARTIAL / INCOMPLETE；不能要求不可写目录仍自证完整，也不能显示虚假成功。
11. Open Experiment Folder 只能打开已登记且经过规范化校验的实验根目录。
12. storage 层只接受持有当前 executionLeaseId 与 fencingToken 的写入；终态后迟到 Worker 写入被拒绝到独立诊断通道。

---

## 14. 非功能需求

### NFR-001：确定性与可审计性

- 确定性指输入和执行条件可审计，不承诺模型输出可重复。
- 相同 Experiment 内所有 Attempt 必须能证明 taskPackageHash、resolvedHarnessFingerprint 和 executionConditionsHash 相同。
- 指纹 canonicalization 在进程重启、不同机器进程和归档重载后必须得到相同结果。
- 状态转换、用户操作和错误均带时间、序号和主体。
- 模型别名无法解析时明确记录 unresolved。

### NFR-002：隔离性

- 每个 Attempt 使用唯一目录。
- Attempt workspace 创建时若目标已存在或非空，必须以 WORKSPACE_NOT_CLEAN 失败，不得清空后继续。
- 输入 baseline 可只读；写入只允许在当前 Attempt workspace。
- 工具不得访问兄弟 Attempt、其他 Run 或实验外未授权路径。
- Retry 不继承上一次的文件、缓存、进程、session、临时目录或环境变量变更。
- baseline 必须在原 workspace 被移动或删除后仍可从 Experiment 自有存储独立物化。
- 旧 execution lease 被撤销后，迟到 Worker 不得改变历史 Attempt 目录的任何已发布字节。

### NFR-003：可靠性与恢复

- 所有控制状态更新必须由 Durable Control Store 事务提交；审计事件追加持久化，投影使用原子替换。
- Start、Retry、Run Again、Retry Failed、Stop 和 Stop All 必须幂等。
- 应用重启不能造成重复 Provider 请求。
- 恢复不了的状态必须转为明确终态，不得永久 Running。
- 磁盘空间不足、权限错误和半写文件必须显式报告。
- 归档不完整时 Durable Control Store 仍必须能保存终态、错误码和完整性标记。

### NFR-004：实时性

- DSH 返回本地模型列表后，正常条件下 2 秒内完成页面呈现。
- 点击 Start 后 300 毫秒内展示确定的 QUEUED 或 PREPARING 状态，不包含 Provider 启动时间。
- 持久化运行事件到 UI 的正常 P95 延迟不超过 1 秒。
- 页面重载后 5 秒内恢复可确认状态或显示 RECOVERING。

### NFR-005：容量与并发

- UI 和存储结构必须支持至少 10 个模型 Run 的单个 Experiment。
- 默认并发 min(4, N)，实际最大值受 DSH 安全上限约束。
- 任意时刻占用并发槽的 Attempt 不得超过设置值；PREPARING、DISPATCHING、RUNNING、RECOVERING 与 CANCELLING 均可能占槽。
- 图片数量、单图大小和总大小不另造限制，直接继承 DSH 可验证限制并在 UI 预先展示。
- 长日志可虚拟化展示，但不能截断磁盘证据。

### NFR-006：安全与隐私

- V1 默认本地保存，不启用未声明的遥测、云同步或上传。
- 创建实验前提示 Prompt、图片和 workspace 内容会发送给所选 Provider。
- 图片必须校验真实 MIME 与内容，不只信任扩展名。
- 所有路径必须规范化并防止目录穿越。
- workspace snapshot 不得跟随越界符号链接。
- 凭据、认证 Header、Cookie、Token 和完整环境变量不得归档。
- 日志和错误详情在写盘前进行已知敏感字段脱敏。

### NFR-007：可访问性与可用性

- 状态不能只靠颜色区分，必须同时有文字和图标。
- 所有核心操作可通过键盘到达。
- 破坏性操作 Stop All 需要明确确认。
- Retry 和 Run Again 必须在按钮文案与说明中区分。
- 错误要给出用户可行动的下一步，不只显示代码。

### NFR-008：兼容性与失败策略

- 插件支持的 DSH 版本范围必须明确。
- 不兼容版本要在 Preflight 前阻止，不能带病运行。
- DSH API 不存在或返回违约数据时大声失败。
- 不得使用隐藏 fallback 或 UI DOM 抓取维持“看似可用”。

---

## 15. 项目目录规划

### 15.1 当前初始化阶段的物理目录

本次任务只创建：

~~~text
deepseek-harness-model-pk/
└── docs/
    └── V1_REQUIREMENTS.md
~~~

不创建空 src、tests 或占位业务代码，不初始化未经要求的框架。

### 15.2 后续实现阶段的建议目录

以下仅是职责规划，待确认 DSH 插件架构后再实际创建：

~~~text
deepseek-harness-model-pk/
├── docs/
│   ├── V1_REQUIREMENTS.md
│   ├── architecture/
│   └── plans/
├── src/
│   ├── domain/          # Experiment、Run、Attempt、状态与错误契约
│   ├── dsh-adapter/     # DSH 模型、附件、session、事件、取消边界
│   ├── orchestration/   # Preflight、队列、并发、Watchdog、重跑
│   ├── storage/         # Manifest、事件、归档与恢复
│   └── ui/              # 创建页、Preflight、Experiment 详情
└── tests/
    ├── unit/
    ├── integration/
    ├── e2e/
    └── fixtures/
~~~

模块职责必须保持清晰：

- domain 不依赖 UI 和 DSH 具体实现。
- dsh-adapter 是唯一 DSH 接入边界。
- orchestration 不直接写散落文件，统一通过 storage。
- UI 从持久化状态和事件投影读取，不维护无法恢复的平行真相。
- 不在 V1 引入第二套 Provider、模型、附件或密钥基础设施。

---

## 16. 验收标准

以下均为 V1 发布前必须通过的端到端验收。测试可以使用可控的 Fake DSH Adapter 注入流式输出、失败、断线和超时，但至少还需对受支持 DSH 版本完成真实集成验收。

### AC-001：模型列表来自 DSH

**Given** DSH 已配置 3 个模型，其中 2 个支持图片  
**When** 用户打开 Model PK 并刷新  
**Then** 页面准确展示 3 个稳定配置项及 Provider、Model ID、显示名和图片能力，且插件没有静态或手工模型旁路。

### AC-002：模型配置变化

**Given** 创建页已经加载模型列表  
**When** DSH 新增、删除或禁用一个配置并点击刷新  
**Then** 创建页反映最新列表；已冻结 Experiment 不被静默修改。

### AC-003：创建输入校验

**Given** 少于 2 个模型、Prompt 为空或 Concurrency 越界  
**When** 用户尝试 Preflight  
**Then** 操作被阻止，并对每个字段显示具体原因。

### AC-004：统一 Prompt

**Given** Prompt 含前后空格、多行和 Unicode  
**When** 选择 3 个模型开始实验  
**Then** 3 个首个 Attempt 的 Prompt 原文与 hash 完全一致，未发生 trim、换行规范化或模型专属改写。

### AC-005：三种图片添加方式

**Given** 用户分别通过选择文件、拖拽和粘贴添加 3 张图片  
**When** 查看附件区与最终 manifest  
**Then** 三张图片均有缩略图、编号、MIME、大小和 hash，且 UI 顺序与 attachments/index.json 一致。

### AC-006：附件变更使 Preflight 失效

**Given** Preflight 已通过  
**When** 用户删除、增加或调整任一图片顺序  
**Then** Preflight 立即回到 NOT_CHECKED，Start PK 禁用，必须重新检查。

### AC-007：图片能力阻断

**Given** Task Package 含图片，选中模型中有一个不支持 image input  
**When** 运行 Preflight  
**Then** 对该模型显示 IMAGE_INPUT_UNSUPPORTED，整个 Experiment 不能开始，Provider 请求数为 0。

### AC-008：不允许图片静默降级

**Given** 某模型只支持文本  
**When** 用户包含图片  
**Then** 系统不执行 OCR、不调用辅助视觉模型、不丢弃图片，也不只发送 Prompt。

### AC-009：Provider Preflight

**Given** 一个 Provider 未配置、一个鉴权失败、一个无法验证实时可用性  
**When** 运行 Preflight  
**Then** 前两个分别显示稳定 BLOCKED 错误码，第三个显示明确 WARNING；不创建任何 Attempt。

### AC-010：冻结后只读

**Given** Experiment 已 Start  
**When** 用户查看创建输入或使用任一重跑入口  
**Then** Prompt、图片、模型集合、baseline 和执行条件均为只读，界面不存在修改入口。

### AC-011：Experiment、Run、Attempt 数量

**Given** 选择 N 个模型并首次开始  
**When** Experiment 冻结成功  
**Then** 创建 1 个 Experiment、恰好 N 个 Run，每个 Run 恰好 1 个 INITIAL Attempt。

### AC-012：相同指纹

**Given** 一个正常启动的 Experiment  
**When** 检查所有 Attempt metadata  
**Then** taskPackageHash 与 executionConditionsHash 均与 Experiment 冻结值相同；附件字节与顺序相同。

### AC-013：受控并发

**Given** N=5，Concurrency=2  
**When** 5 个初始 Attempt 运行  
**Then** 任意时刻 PREPARING 与 RUNNING 总数不超过 2，其余显示 QUEUED；排队顺序与用户选择顺序一致。

### AC-014：QUEUED 不计执行超时

**Given** 最后一路在队列等待超过硬执行时限  
**When** 它尚未 dispatch  
**Then** 不进入 TIMED_OUT；硬执行计时从正式 dispatch 开始。

### AC-015：workspace 相互隔离

**Given** 两个模型并行运行  
**When** Run A 在自己的 workspace 写入唯一标记文件  
**Then** Run B 无法读取该文件，且兄弟 Run 的输出不出现在 Run B workspace。

### AC-016：Retry 使用干净 workspace

**Given** Attempt 1 写入临时文件后失败  
**When** 用户点击单路 Retry  
**Then** Attempt 2 从同一 baseline 创建新目录，临时文件不存在；Attempt 1 目录原样保留。

### AC-017：单路 Retry

**Given** 一个 Run 最新 Attempt 为可重试 FAILED，其他 Run 已成功  
**When** 用户点击该 Run 的 Retry  
**Then** 仅该 Run 新增一个 RETRY Attempt，其他 Run 不变，且新 Attempt 受原并发限制。

### AC-018：成功单路 Run Again

**Given** 一个 Run 最新 Attempt 已 SUCCEEDED  
**When** 用户点击 Run Again  
**Then** 同一 Run 新增一个 RUN_AGAIN Attempt，复用冻结输入和执行条件；旧成功结果仍可查看。

### AC-019：Retry Failed

**Given** 最新状态分别为 SUCCEEDED、FAILED、TIMED_OUT、STALLED、DISCONNECTED、CANCELLED 和正在 RUNNING 的 7 个 Run  
**When** 用户确认 Retry Failed  
**Then** 只为可重试的 FAILED、TIMED_OUT、STALLED、DISCONNECTED 各新增一个 Attempt；其他 Run 不变，并记录同一 batchActionId。

### AC-020：重跑配置漂移

**Given** Experiment 冻结后 DSH 模型配置发生变化，且无法按原快照执行  
**When** 用户点击 Retry 或 Run Again  
**Then** 系统以 MODEL_CONFIG_DRIFT 阻止新 Attempt，不静默使用新配置。

### AC-021：重跑幂等

**Given** 网络重复提交同一个 Retry、Run Again 或 Retry Failed 操作 ID  
**When** 后端收到多次请求  
**Then** 每个目标 Run 最多新增一个 Attempt。

### AC-022：失败、卡死、掉线、超时分类

**Given** 测试适配器分别注入一般 Provider 错误、无有效进展、执行流断开和硬时限到达  
**When** Attempt 结束  
**Then** 状态分别为 FAILED、STALLED、DISCONNECTED、TIMED_OUT，并有相匹配的结构化 error.code，不能统一显示为 FAILED。

### AC-023：浏览器掉线不影响执行

**Given** Attempt 在后端 RUNNING  
**When** 浏览器断网或页面关闭后恢复  
**Then** 后端继续执行；重连后状态和日志补齐且无重复，Attempt 不因前端掉线进入 DISCONNECTED。

### AC-024：单路 Stop

**Given** 一个 Run 正在运行，其他 Run 也在运行  
**When** 用户 Stop 目标 Run  
**Then** 目标进入 CANCELLING 后成为 CANCELLED，其他 Run 继续；目标历史日志和产物保留。

### AC-025：Stop All

**Given** Experiment 同时有成功、失败、排队和运行中的 Attempt  
**When** 用户确认 Stop All  
**Then** 只取消排队与运行中的 Attempt，已成功和已失败记录不变。

### AC-026：取消与完成竞态

**Given** 完成事件和取消确认几乎同时到达  
**When** 状态持久化  
**Then** 只有第一个原子终态生效；迟到事件只进入诊断日志。

### AC-027：实时日志

**Given** 模型和工具持续产生事件  
**When** UI 正常在线  
**Then** 事件按序显示，正常 P95 延迟不超过 1 秒；暂停自动滚动不影响磁盘持续归档。

### AC-028：Attempt 历史

**Given** 一个 Run 有 3 个 Attempt  
**When** 打开 Run 详情  
**Then** 默认显示 Attempt 3 of 3，并可切换查看前两个 Attempt 的 Output、Logs、Transcript、Artifacts 和 Metadata。

### AC-029：完整归档

**Given** 一个 Experiment 包含成功和失败 Run  
**When** 所有 Attempt 进入终态  
**Then** 实验目录包含 experiment manifest、Prompt、附件与索引、Run metadata、每个 Attempt 的 metadata、events、logs、transcript、结果或 error，以及独立 workspace 和 artifacts。

### AC-030：归档无凭据

**Given** DSH 使用 API Key、Authorization Header、Cookie 或签名 URL  
**When** 扫描完整实验目录  
**Then** 不存在明文凭据；已知敏感字段均已脱敏。

### AC-031：一键打开目录

**Given** Experiment 目录存在  
**When** 点击 Open Experiment Folder  
**Then** 本机文件管理器打开准确的实验根目录。目录缺失或无权限时，显示具体错误并允许复制原登记路径。

### AC-032：宿主重启恢复

**Given** 有 Attempt 处于 RUNNING 时 DSH 宿主重启  
**When** 插件恢复  
**Then** 不重复提交；可重连则续接，不可确认则先 RECOVERING，最终明确为 DISCONNECTED 或恢复后的真实状态。

### AC-033：单路故障隔离

**Given** N 个 Run 中一路 workspace 准备失败  
**When** 该路进入 FAILED  
**Then** 其他已 dispatch 或排队的 Run 按正常策略继续，不被连带终止。

### AC-034：V1 范围检查

**Given** 完成的 V1 UI、接口、配置和数据结构  
**When** 做发布审查  
**Then** 不存在自动 Judge、自动评分、Elo、排行榜、Codex CLI、Claude Code CLI、Agent Router、Prompt 模板库或批量 Benchmark 执行路径。

### AC-035：固定 DSH Harness

**Given** 选择多个模型运行同一 Experiment  
**When** 比较每个 Attempt 的 effective input 与 Harness metadata  
**Then** Agent Loop、逻辑系统提示词、工具清单、工具描述、权限和公共限制一致，差异仅来自冻结的模型配置及不可避免且已记录的 Provider Adapter 行为。

---

## 17. V2 与 V3 边界

### 17.1 V2：人工比较与实验复用

V2 可以在不引入自动裁判的前提下扩展：

- 本地实验历史浏览、搜索、标签与重新打开。
- 实验 Clone and Edit。
- Prompt 或 Task Package 模板。
- 人工备注、人工胜负选择、盲评模式。
- 更强的并排查看、文本或文件 diff。
- 导出、导入和脱敏分享包。
- Token、成本、延迟与稳定性元数据可视化。
- 多次人工触发采样与 Attempt 对照。
- 受控的公共参数实验与 Strict / Native 公平模式。

V2 仍不自动判断内容质量，不产生 Elo 或排行榜。

### 17.2 V3：正式自动评测平台

V3 才考虑：

- Dataset 与批量 Benchmark。
- 自动 Judge、Rubric 与多 Judge 共识。
- 自动评分、统计显著性、Elo 和排行榜。
- 多次重复采样、方差和稳定性统计。
- Headless、CI、定时或分布式执行。
- 大规模实验调度与结果分析。

### 17.3 Agent Arena 是独立产品轨道

Codex CLI、Claude Code CLI、其他 Agent Runtime 和 Agent Router 不应被当作 Model PK 的自然小版本扩展。它们比较的是 Agent Scaffold、工具链、权限和 Runtime，应该在未来以独立 Agent Arena 规格讨论，避免混淆“模型能力”和“Agent 产品能力”。

---

## 18. 实现前待确认项

以下是 DSH 兼容性与运行策略的待确认项，不是扩大 V1 范围的授权：

1. DSH 正式模型枚举、能力查询和配置 ID API 的名称与稳定性。
2. 固定 Harness Profile 的确切 Agent Loop、系统提示词、工具集和权限。
3. workspace baseline 的来源、快照格式和忽略规则。
4. DSH 是否可按冻结模型快照重放，还是只能使用当前配置。
5. Provider Adapter 是否会修改 Prompt、图片、system message 或公共参数。
6. DSH 的取消确认、流式重连与宿主重启恢复能力。
7. Provider 或 DSH 内部低层自动重试是否可禁用或观测。
8. 图片格式、数量、大小和不同模型能力交集的准确限制。
9. V1 默认 NO_PROGRESS_WARNING、STALLED、硬超时和取消宽限期的最终数值。
10. 实验数据根目录、文件权限、保留周期和用户删除策略。
11. 首发操作系统范围及 Open Experiment Folder 的正式接口。
12. Provider 模型别名能否解析到真实 revision。

每个待确认项都必须在技术设计或兼容性报告中得到结论。若结论影响公平性、归档或恢复，必须在开始对应模块实现前解决。

---

## 19. 推荐实现顺序

遵循最小端到端、逐层验证原则：

### Stage 0：DSH Compatibility Spike

- 只验证模型枚举、配置 ID、能力查询、session、流式事件、附件、取消、workspace 和 UI 扩展点。
- 输出兼容性文档，不构建并行产品功能。

### Stage 1：最小文本纵切

- 2 个 DSH 模型。
- 1 个统一文本 Prompt。
- 固定 Harness Profile。
- Experiment、Run、Attempt。
- Concurrency=2。
- 实时状态和最小 manifest。

完成后先验证相同输入与 Run 隔离。

### Stage 2：Task Package 与 Preflight

- 多图上传、拖拽、粘贴。
- 图片 hash 与有序归档。
- Provider、模型和图片能力 Preflight。
- workspace baseline 与 Fair Mode 指纹。

### Stage 3：状态机与重跑

- Watchdog。
- Stop、Stop All。
- Retry、Run Again、Retry Failed。
- 幂等、干净 workspace 与 Attempt 历史。

### Stage 4：归档、恢复与硬化

- 完整 transcript、logs、metadata 和 artifacts。
- 页面重连和宿主恢复。
- 一键打开目录。
- 脱敏、权限、错误映射、容量与端到端测试。

任何阶段都不应提前加入 Judge、评分、排行榜或 CLI Agent。

---

## 20. V1 Definition of Done

只有同时满足以下条件，V1 才算完成：

1. FR-001 至 FR-016 均实现且没有静默降级。
2. AC-001 至 AC-035 全部通过。
3. 对受支持 DSH 版本完成真实 Provider 集成测试。
4. 失败、卡死、掉线、超时、取消和恢复均有可重复测试。
5. Retry、Run Again、Retry Failed 的语义、幂等性和 workspace 清洁性有自动化测试。
6. manifest、Prompt、附件、metadata、transcript、日志和产物目录均经人工抽查。
7. 完整归档通过凭据扫描。
8. 文档中的支持范围、限制与 UI 实际行为一致。
9. 未引入任何 V1 非目标。

---

## 21. 需求追踪矩阵

| 原始需求 | 对应章节 |
|---|---|
| 项目定位 | 2 |
| 只评测模型能力，不评测 Codex / Claude Code CLI Agent | 2.2、2.4、3.3 |
| 从 DSH 读取模型并多选 | 5、FR-001、FR-002 |
| 统一 Prompt | 6、FR-003 |
| 多图片上传、粘贴、拖拽 | 8.2、FR-004 |
| 相同 Prompt、附件、条件和公平性 | 6 |
| N 模型并行与并发控制 | FR-009 |
| 每个模型独立 Run | 4.4、10 |
| Experiment → Run → Attempt | 4、10 |
| 失败、卡死、掉线、超时、取消状态机 | 11、12 |
| 单路 Retry、Run Again、Retry Failed | 8.6、8.7、8.8、FR-013 |
| 重跑使用同一 Task Package | 6.4、FR-013 |
| 重跑使用干净 workspace | FR-005、NFR-002 |
| Preflight | 7.2、FR-007 |
| 实时状态、日志和独立产物 | FR-010、FR-014 |
| manifest、Prompt、附件、metadata、transcript 归档 | 13 |
| 一键打开实验目录 | FR-015 |
| 页面结构与用户流程 | 7、8 |
| 功能与非功能需求 | 9、14 |
| 目录规划 | 13、15 |
| 错误码与状态 | 11、12 |
| 验收标准 | 16 |
| V2 / V3 边界 | 17 |

---

## 22. 最终范围声明

V1 的产品价值不依赖自动评分。第一版只需要把下面这件事做到稳定且可信：

> 一次输入同一 Task Package，选择 N 个 DSH 模型，在固定 Harness 与隔离 workspace 中并行执行；全过程可观察，异常单路可重跑，任何 Attempt 都不覆盖，所有证据与产物均可追溯。

达到该目标后即冻结 V1。所有自动评判、排行榜、批量 Benchmark 和外部 Agent 调度均作为独立后续工作处理。
