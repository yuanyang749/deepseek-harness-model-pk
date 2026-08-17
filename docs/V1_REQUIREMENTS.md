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

> 同一份 Prompt、同一组有序图片、同一 workspace 基线和同一 DSH 执行规则，可以一次交给 N 个已配置模型；单路故障不会影响其他模型；任一重跑不会污染或覆盖历史；只有 experimentArchiveFreshness=CURRENT 且 experimentArchiveIntegrity=COMPLETE 时，才可以仅凭归档目录还原“谁在什么条件下、何时、如何运行以及产生了什么结果”。其他组合必须明确提示还需 Durable Control Store、修复或重新封存，不能冒充完整实验归档。

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

Execution Conditions 至少冻结 Concurrency、队列策略、prepareTimeout、hardExecutionTimeout、noProgress / stall 阈值、cancelGrace、dispatchConfirmationWindow、recoveryTimeout、finalizationTimeout 和底层 Retry 策略；所有绝对 deadline 都从这些冻结时长一次性计算并持久化。

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
- 每个 Attempt 在创建时预留唯一归档身份与路径；只有进入相应阶段时才物化全新 session、workspace、日志、transcript 和产物。QUEUED 即取消或早期 PREPARE 失败时，以 `available=false + reason` 记录未物化项，不能伪造空 session / workspace / result。
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
- 密钥只由 DSH 管理；插件不得主动采集或归档 DSH / 插件管理的密钥、认证 Header、Cookie、签名 URL 或 secret 环境变量。用户主动写入 Prompt、workspace 或模型回显中的秘密属于内容数据，按风险提示与已知模式扫描处理，不能虚假承诺通用脱敏必然识别。

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
- V1 Strict Fair Mode 不允许缩放、重压缩、裁剪、格式转换等改变图片字节或视觉内容的有损转换；即使某个统一规则可以应用到所有 Run，也必须以 ATTACHMENT_CONTENT_TRANSFORMED 硬阻断。允许统一有损预处理只可作为未来另行定义的模式，不能在 V1 静默放行。
- 图片任务中，每个 Adapter 必须提供可观察的 effectiveContentHash，或提供被版本锁定并有测试证明的 lossless adapter contract。两者都没有时必须以 ATTACHMENT_TRANSFORM_UNVERIFIED 硬阻断，不能作为可确认 WARNING 放行。
- 包含图片时，只允许原生支持 image input 的模型通过 Preflight。
- 不得用另一个视觉模型先解释图片再把文字交给纯文本模型。

### 6.3 参数公平性与模型固有差异

- V1 不提供逐模型 Temperature、Thinking、Reasoning Effort 等高级参数编辑。
- 公共限制使用同一固定值；某模型不支持强制公共参数时，Preflight 必须阻止该实验开始，不能静默丢弃参数。
- 模型自身在 DSH 中的标准默认参数属于模型配置快照，允许不同，但必须可见并写入 metadata。
- Provider Adapter 的协议序列化差异是固有差异；插件不得加入模型专属 Prompt 改写。
- 若实际服务端模型 revision 无法解析，manifest 必须记录 unresolved，不能宣称跨时间完全可复现。

### 6.4 指纹与规范化

V1 的指纹算法是实现契约，不允许各模块自行选择等价方案：

1. 所有结构化指纹对象必须包含 schemaVersion，并且**必须**使用 RFC 8785 JSON Canonicalization Scheme；hash 格式固定为 `sha256:<lowercase-hex(SHA-256(UTF-8(JCS(object))))>`。
2. 输入必须满足 I-JSON：只允许有限 JSON 数字；整数必须在安全整数范围内并通过字段 schema 校验；NaN、Infinity、负零以及不符合字段语义的数字直接拒绝。
3. 缺失字段必须省略，显式空值编码为 `null`，二者不得互换；数组顺序保持原序。字符串若包含非法 UTF-16 孤立代理项，必须以 INPUT_ENCODING_INVALID 拒绝，不能替换字符后继续。
4. Prompt 与解析后的系统提示词各自按原始 UTF-8 字节先计算 SHA-256，再以 `{encoding, byteLength, sha256}` 描述符进入 canonical 对象；原始字节另行归档。不得 trim、改写或规范化换行。
5. 二进制附件不进入 JSON 正文，而以 ordinal、MIME、byteSize 和 SHA-256 的有序记录参与计算。
6. Start、Retry、Run Again、Retry Failed、Stop 与 Stop All 的 requestHash 必须复用同一 JCS + SHA-256 规范，不能使用语言运行时默认对象序列化。

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
- Queued、Active、Finalizing、Finished 四类互斥计数：QUEUED 归 Queued；PREPARING、DISPATCHING、RUNNING、RECOVERING、CANCELLING 归 Active；FINALIZING 归 Finalizing；所有终态归 Finished。四类之和始终等于 Run 总数。
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
→ 执行结果冻结后进入 FINALIZING
~~~

Start 前允许编辑。任何会影响实验的编辑都会使既有 Preflight 立即失效。Start 后 Task Package、模型集合和 Execution Conditions 全部只读。

Start PK 必须幂等。manifest、Run、INITIAL Attempt 与入队意图属于同一个逻辑提交；不能让用户看到只有部分 Run 的 Experiment。若文件系统无法跨文件原子提交，必须先在 Durable Control Store 中事务提交并使用 commit marker 完成归档投影。重复 startActionId 返回同一个 Experiment；相同 ID 携带不同内容则报冲突。

### 8.2 添加图片

用户可以通过文件选择、拖拽或粘贴截图添加图片。每张图显示缩略图、编号、文件名、格式、大小、上传状态和删除操作；Start 前可调整顺序。

粘贴普通文本时不得被图片处理逻辑拦截。剪贴板含图片时添加附件。支持的格式、数量和大小限制必须直接继承并展示 DSH 的实际限制，前端和运行端不得各自维护不同规则。

每个附件状态为 UPLOADING、READY 或 FAILED。只有所有保留附件均为 READY，且不可变引用和 SHA-256 已生成时，才允许 Preflight。FAILED 附件必须被成功删除或重新上传，不能被冻结进 Task Package。

### 8.3 Preflight

Preflight 不创建 Attempt、不预留 Durable Control Store 容量，也不发送用户任务 Prompt。它只检查当前时刻的容量可用性和快照能否可靠运行；真正容量预留只在 Start 或重跑 Action 的创建事务中发生。任一硬阻断项存在时，所有模型均不得开始；V1 不提供“先跑可用模型”的隐式降级。

Start PK 只有在“当前 taskPackageHash、resolvedHarnessFingerprint、executionConditionsHash 和模型集合”对应的 Preflight 已完成，且结果为 READY，或 WARNING 已被用户对该快照明确确认时才启用。NOT_CHECKED、CHECKING、BLOCKED 以及未确认 WARNING 一律禁用 Start。任何相关编辑都会同时清除 WARNING 确认。

### 8.4 实时观察

用户在一个页面中观察 N 个 Run。事件到达后更新状态、流式输出、最后活动时间和日志。刷新页面或 UI 临时断线不得改变后端 Attempt 状态；重连后从持久化游标补齐事件。

### 8.5 单路 Stop 与 Stop All

- 用户点击单路 Stop 时，UI 和控制层必须冻结确切的 attemptId 与 expectedLifecycleVersion；该操作只作用于点击瞬间的目标，执行时不得重新解析 Run 的“当前 Attempt”。
- Stop All 确认弹窗打开时的目标列表只作预览；用户确认提交的瞬间，后端必须在一个控制存储事务快照中冻结全部可取消目标的 attemptId 与 expectedLifecycleVersion。确认提交后新创建的 Attempt 不属于本次 Stop All；已进入 FINALIZING 的 Attempt 不可取消、不属于目标，并继续幂等收尾。
- 已成功、已失败或已归档结果不得删除。
- 已处于 CANCELLING 的 Attempt 对重复 Stop 幂等返回。
- 目标已进入终态或 lifecycleVersion 已变化时，相同 operationId 返回原幂等结果；新的过期操作返回 ACTION_TARGET_STALE，且绝不能误取消替代它的新 Attempt。
- QUEUED 走不接触 Provider 的直接取消路径，进入 FINALIZING 后成为 CANCELLED；其余可取消执行先进入 CANCELLING。如果模型完成、失败或超时事件先原子冻结 pendingOutcome，则该真实结果获胜。取消失败时按第 11 节恢复为 RUNNING、进入 RECOVERING 或以明确错误结束。

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
- Durable Action 记录至少保存 operationId、type、experimentId、requestHash、frozenTargets、status 和 result；frozenTargets 对 Stop 类操作必须包含 attemptId 与 expectedLifecycleVersion。相同 operationId 携带不同 requestHash 必须返回 ACTION_ID_CONFLICT。
- 创建新 Attempt 时必须以 latestAttemptId 做 compare-and-set，并硬性保证每个 Run 最多一个非终态 Attempt。单路操作与批量操作竞争时只允许一个成功，另一方返回 ACTION_TARGET_STALE。
- 每个会创建 Attempt 的 Action 都必须在同一 Durable Control Store 事务中先预留该 Attempt 最坏情况下的控制写入容量，再创建身份与入队意图；预留失败则零创建并返回 CONTROL_STORE_CAPACITY_UNAVAILABLE。
- Retry Failed 在一个控制存储事务中为冻结目标集合整体预留容量并全部创建 Attempt；容量不足或任一目标在提交前变为 stale 时，本次批量操作全部不创建，并要求用户重新确认，禁止半批成功。
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
- snapshot 实体必须复制或内容寻址地纳入 Experiment 拥有且享受垃圾回收豁免的存储；运行中可以复用外部全局对象，但若要把 Experiment 标为 archive CURRENT + COMPLETE，所有 baseline 对象必须物化到实验根目录内并纳入 seal hash。只保存外部引用不满足完整归档。
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
- DSH 能为每个 Attempt 创建不复用历史上下文、记忆与可写运行环境的全新 session；无法证明时硬阻断。
- Runner sandbox 必须保证即使旧执行失联或成为 orphan，也只能触达其自身 workspace，不能访问兄弟或后续 Attempt 的路径；无法证明跨 Attempt 路径隔离时硬阻断。
- 图片格式、数量、大小和上下文限制可接受。
- 图片 Adapter 可以通过 effectiveContentHash 或版本锁定的 lossless contract 证明未做模型专属内容变换。
- 公共参数、输出上限和超时策略可被执行。
- workspace baseline 可读取并可物化。
- 实验与归档目录可写。
- Durable Control Store 当前可写，且按本次候选数量估算有足够控制容量；这只是无副作用检查，不占用容量，Start 仍须在原子事务中重新预留并可能因竞争返回 CONTROL_STORE_CAPACITY_UNAVAILABLE。
- 固定 Harness Profile 与 Adapter 可用，且可解析 resolvedHarnessFingerprint。

Preflight 状态为 NOT_CHECKED、CHECKING、READY、WARNING、BLOCKED。Start PK 仅在当前指纹对应的检查已完成并为 READY，或全部 WARNING 已对当前快照明确确认时启用。NOT_CHECKED、CHECKING、BLOCKED 和未确认 WARNING 一律禁用。任何 Task Package、模型、Resolved Harness 或执行配置变化都会令结果与 WARNING 确认失效。

### FR-008：实验冻结与 Manifest

- Start PK 必须携带 startActionId，并在同一 Durable Control Store 事务中先为 N 个 INITIAL Attempt 预留最坏情况控制容量，再逻辑原子地提交 Experiment、N 个 Run、N 个 INITIAL Attempt 和入队意图。预留失败时除幂等 Action 结果外零创建，并返回 CONTROL_STORE_CAPACITY_UNAVAILABLE。
- Start PK 前必须写入 experiment.json、Task Package 快照、全部 run.json、definition-index.json 和 start.commit；索引与 marker 校验成功前，零 Attempt 可以 dispatch。
- 冻结后不得修改 Prompt、附件、模型集合、baseline 或公共执行条件。
- 若 manifest 写入失败，零 Attempt 可以 dispatch。
- 每个 Experiment 使用稳定 UUID 和安全 slug，显示名不能作为唯一身份。
- 重复 startActionId 必须返回同一个结果；相同 ID 携带不同请求必须返回 ACTION_ID_CONFLICT。
- 启动中崩溃后必须完成原提交或进入 START_FAILED，不得留下可运行的部分 Experiment，也不得重复创建 Run。

### FR-009：N 模型运行与并发

- 每个选中模型创建一个独立 Run。
- 每个 Run 的初始 Attempt 进入同一个全局实验队列。
- Concurrency 范围为 1 到 min(N, DSH 后端安全上限)，默认 min(4, N)。
- 调度器在 QUEUED → PREPARING 的同一控制事务中获取持久化 execution reservation；是否占槽以 reservation 为准，而不是仅凭 UI state 推断。获取时立即持久化 `preparingDeadlineAt = reservationAcquiredAt + prepareTimeout`，并将初始 reservationReleaseDeadline 设为 `preparingDeadlineAt + cancelGrace`，因此在 dispatch intent 之前崩溃也有可恢复上界。
- 写入 dispatch intent 时，将 reservationReleaseDeadline 单调更新为 `max(现值, dispatchIntentAt + dispatchConfirmationWindow + hardExecutionTimeout + cancelGrace)`；收到 dispatch ACK 时再单调更新为 `max(现值, dispatchAckAt + hardExecutionTimeout + cancelGrace)`。这些时长必须冻结进 Execution Conditions，deadline 重启后不得重算、缩短或重复延长。
- 无法确认终止时，旧 Attempt 保守占用槽到 reservationReleaseDeadline；到期后可原子改为 ORPHANED、写入 orphanedExecution=true / orphanedAt 并释放受控调度槽。该标记必须单独展示，产品不宣称能证明外部 Provider 僵尸请求已停止。
- 任意时刻占用并发槽的 Attempt 数不得超过 Concurrency。
- 队列采用全局 FIFO。初始 Attempt 按 Run ordinal 入队；单路重跑追加到队尾；批量重跑在同一批内按 Run ordinal 排序后整体追加到队尾。V1 不抢占、不插队。
- QUEUED 等待时间不计入硬执行超时。
- 首次运行与所有重跑共用同一并发额度，不得绕过调度器。

### FR-010：实时状态与日志

- UI 必须展示每路状态、Attempt 编号、运行时长、最后有效活动和输出摘要。
- FINALIZING 必须显示为独立的“正在归档/收尾”状态；此时 Stop、Retry 和 Run Again 禁用，不能继续显示为 RUNNING 或假装已完成。
- 日志必须带单调序号与时间戳，支持自动滚动暂停和复制。
- UI 可以虚拟化长日志，但磁盘归档不得因 UI 截断。
- Token、成本、首 token 延迟和 Provider request ID 仅在 DSH 可可靠提供时展示；缺失显示为不可用，不得猜测。

### FR-011：Watchdog

- 每个 Attempt 维护 workerHeartbeatAt 与 lastProgressAt，两者不得混用。
- 有效进展包括模型输出片段、模型完成消息、工具调用、工具结果、受控文件操作或 DSH 明确进度事件。
- 仅有进程 heartbeat 不能证明模型产生进展。
- 建议 V1 默认值：3 分钟无进展显示 NO_PROGRESS_WARNING，5 分钟无进展时冻结 pendingOutcome=STALLED 并进入 FINALIZING，30 分钟达到硬执行时限时冻结 pendingOutcome=TIMED_OUT 并进入 FINALIZING，取消宽限期 10 秒。
- 这些有效值必须写入 Execution Conditions；最终数值应在 DSH 集成测试后冻结。
- 达到 STALLED 后不得自动 Retry。
- Attempt 进入 FINALIZING 后停止模型 Watchdog，改用独立 finalization deadline；收尾超时映射为归档或隔离错误，不得反向改写已冻结的模型执行结果。

### FR-012：取消

- QUEUED Attempt 取消时不进入 CANCELLING，而是直接冻结 pendingOutcome=CANCELLED、进入 FINALIZING，且不得向 Provider dispatch。
- PREPARING、DISPATCHING、RUNNING 或 RECOVERING Attempt 接受 Stop 后进入 CANCELLING；已是 CANCELLING 时幂等返回。
- Stop 请求必须携带冻结的 attemptId 与 expectedLifecycleVersion；Stop All 必须携带确认提交瞬间事务性冻结的目标集合。状态变化后到达的旧请求不得取消新 Attempt。流式输出、heartbeat、lastProgressAt 和日志追加不递增 lifecycleVersion，因此不会让正常 Stop 误报 stale。
- 宽限期内完成底层取消则冻结 pendingOutcome=CANCELLED 并进入 FINALIZING；必要时执行受控强制终止并撤销写 lease。
- CANCELLING 期间先到达的真实完成、失败、超时、卡死或掉线结果可以通过原子 compare-and-set 获胜并进入 FINALIZING。
- 取消命令失败但执行仍被确认健康时，Attempt 回到 RUNNING 并记录 CANCEL_FAILED Action；无法确认时进入 RECOVERING，最终恢复或经 FINALIZING 成为 DISCONNECTED；取消失败同时终止 Runner 时冻结 FAILED + CANCEL_FAILED 并进入 FINALIZING。
- 完成与取消竞态以第一个原子冻结的 pendingOutcome 为准。
- 迟到事件不得改变终态，只能进入诊断日志。

### FR-013：重跑

- Retry、Run Again 和 Retry Failed 均只新增 Attempt。
- 创建任一重跑 Attempt 前必须在同一控制事务中完成最坏情况控制容量预留；失败时不得创建 Attempt、目录或入队意图。
- 新 Attempt 必须复用并校验相同 modelConfigFingerprint、taskPackageHash、resolvedHarnessFingerprint 和 executionConditionsHash。
- 新 Attempt 一旦进入 session / workspace 物化路径，必须使用全新的实体；非空 dshSessionId、workspacePath、可写实体身份和临时目录均不得与任一旧 Attempt 相同。首条有效上下文只能来自冻结的 Task Package 与 Harness，不得含旧 transcript、记忆或模型输出。若在物化前终态，则对应引用为空并记录 `available=false + reason`。
- 每个 Attempt 获得唯一 executionLeaseId 与 fencingToken；进入终态前，已签发的旧写 lease 必须始终撤销。旧 Worker 的迟到写入由 storage 层拒绝并进入独立诊断通道。
- 若无法确认旧执行已终止，但已成功撤销写 lease，且 Runner sandbox 能证明旧执行无法访问兄弟或后续 Attempt，可以创建重跑 Attempt；它先进入 QUEUED，并在旧 Attempt 保守占用 reservation 期间不得 dispatch。UI 必须显示 executionTerminationConfirmed=false、等待原因与可能继续计费的警告；无法证明这种 replacement isolation 时禁止创建重跑。
- replacement isolation 与旧归档封存是两层承诺：前者只要求旧 DSH 工具、子进程和直接文件写入无法触达新 Attempt；后者还要求它们不能再写旧 Attempt 的 transcript、workspace 与产物。仅满足前者时可在 reservation 释放后安全启动全新 workspace，但旧归档必须保持 QUARANTINED_UNSAFE / INCOMPLETE，不得声称历史字节已冻结。
- 重跑入口不得允许修改任何冻结字段。
- 历史 Attempt 目录不得覆盖。

### FR-014：独立结果与产物

- 每个 Attempt 创建时必须有唯一归档目录与 metadata / events 位置；workspace、transcript、result 和 artifacts 只在相应阶段物化，但任何已物化实体都必须独立且不复用。未物化项以 `available=false + reason` 归档。
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
- 若 DSH 支持幂等键或按键查询，恢复时必须查询并续接原请求。若不支持，处于“已发送但 ACK 未落盘”窗口的 Attempt 不得自动重发，而是进入 RECOVERING，最终经 FINALIZING 以 DISCONNECTED + RECOVERY_UNRESOLVED 结束。
- QUEUED 在重启后保持队列语义；PREPARING、DISPATCHING、RUNNING 与 CANCELLING 均必须有合法 RECOVERING 路径和固定 recovery deadline；FINALIZING 必须按 finalizationId 与阶段 marker 原地幂等续作。
- 若 DSH 支持 session 恢复则续接；无法确认的 Attempt 最终明确恢复或经 FINALIZING 以 DISCONNECTED 结束，不能永久停在 RUNNING。

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
| lifecycleVersion | 生命周期 CAS 版本；QUEUED 创建时为 0，仅在成功提交生命周期状态转换时加 1 |
| observedExecutionOutcome / pendingOutcome | 观察到的模型/执行结果与 FINALIZING 初始目标终态，可空 |
| finalizationId / finalizationStage / finalizationDeadlineAt | 幂等收尾身份、结果型阶段 marker 与一次性计算的截止时间，可空 |
| taskPackageHash | 输入一致性校验 |
| resolvedHarnessFingerprint | 固定 Harness 一致性校验 |
| executionConditionsHash | 执行条件一致性校验 |
| modelConfigFingerprint | 本 Run 模型配置校验 |
| inputFingerprint | 模型可见输入与基线指纹 |
| effectiveInputHash | Adapter 后语义输入指纹，可空 |
| dispatchIntentId / idempotencyKey | dispatch 恢复与防重 |
| dshSessionId | DSH session 引用；在 session 创建前终态时可空，并须记录 available=false 原因 |
| providerRequestId | 可用时记录 |
| queuedAt / preparingAt / preparingDeadlineAt / dispatchIntentAt / dispatchAckAt | 启动时序 |
| startedAt / executionEndedAt / finalizationStartedAt / finalizedAt | 模型执行与收尾分离时序 |
| firstOutputAt / lastProgressAt / workerHeartbeatAt | 观察指标 |
| executionLeaseId / fencingToken | 底层写入栅栏 |
| executionTerminationConfirmed | 是否确认底层终止 |
| executionReservationState | NOT_ACQUIRED、HELD、RELEASED 或 ORPHANED |
| reservationAcquiredAt / reservationReleaseDeadline | 并发 reservation 时序与保守释放期限 |
| orphanedExecution / orphanedAt | 无法确认远端停止而释放受控槽时的显式标记 |
| workspaceSealState | OPEN、SEALED 或 QUARANTINED_UNSAFE |
| workspacePath / artifactPath | 已物化的独立目录；早期终态时可空并记录原因 |
| logRef / transcriptRef / metadataRef | 归档引用 |
| finalResponseRef | 最终文本结果 |
| archiveCompleteness | COMPLETE、PARTIAL 或 INCOMPLETE |
| error | 主结构化错误；FAILED、TIMED_OUT、STALLED、DISCONNECTED 必填，SUCCEEDED / 正常 CANCELLED 可空 |
| archiveError | 次级归档错误，可空；不得覆盖原执行错误或取消原因 |
| cancelReason | 取消原因，可空 |

Attempt 运行期间的 metadata.json 是由 Durable Control Store 与事件生成的原子替换投影；进入终态并完成 finalization commit 后冻结。终态、输入指纹、错误和已发布产物引用不得再改写。迟到事件只追加到隔离诊断通道。

lifecycleVersion 只对 QUEUED → PREPARING、RUNNING → CANCELLING、任一执行态 → FINALIZING、FINALIZING → 终态等生命周期转换递增。输出片段、heartbeat、日志、lastProgressAt、指标和普通 metadata 投影更新不得递增它。Stop 的 compare-and-set 必须同时匹配 attemptId、expectedLifecycleVersion 和可取消状态集合。

### 10.5 可变状态投影

state.json 只保存可重建的当前投影，至少包括：

- Experiment lifecycleState 与 outcome。
- experimentGeneration、semanticEventCursor、auditSequence、attemptSetHash、experimentArchiveFreshness、experimentArchiveIntegrity、archiveRevision 与最新生效 seal/index hash。
- 每个 Run 的 latestAttemptId、lastSuccessfulAttemptId、derivedState 和 attemptCount。
- Queued、Active、Finalizing、Finished 四类计数及 Run 总数。
- 当前活动 Action 与恢复提示。

删除 state.json 后，必须可以从不可变定义、Durable Control Store 和有序事件重建相同投影。

### 10.6 Durable Control Store

V1 必须有一个独立于实验归档目录的最小耐久控制存储。可使用 SQLite 或提供等价事务、唯一约束和崩溃恢复能力的实现。它是运行期间以下信息的事实来源：

- Start 与所有用户 Action 的幂等记录。
- Experiment、Run、Attempt 身份及最新状态。
- 每个 Run 最多一个非终态 Attempt 的约束。
- dispatch intent、ACK、session 引用和恢复截止时间。
- lifecycleVersion、observedExecutionOutcome、pendingOutcome、finalizationId、finalizationStage 与 finalizationDeadlineAt。
- execution lease、fencing token、reservation 状态/期限与 orphan 标记。
- Attempt 终态 / archiveCompleteness，以及 Experiment 的 generation、attemptSetHash、archive freshness / integrity / revision。
- Experiment 控制审计的 auditSequence、归档相关的 semanticEventCursor 与 sealActivationId。

Durable Control Store 与实验归档必须具有独立的失败处理。Start 和每个创建 Attempt 的后续 Action 都必须在同一事务中为新 Attempt 预留最坏情况下的控制写入容量；若无法预留则对应操作零创建且不得 dispatch。这里的“独立”不意味着同一故障卷完全不可写时仍能凭空持久化：一旦控制存储自身不可写，调度器必须 fail closed，停止新 dispatch、尽力撤销 lease 并隔离现有执行，在 UI 明确显示“持久状态未知”，待存储恢复后按 Provider/session 证据对账，不能宣称终态已经保存。

experiment.json 与 run.json 是冻结定义的事实来源；Durable Control Store 是运行控制状态的事实来源；Experiment 根 events.jsonl 是可重建的提交后审计导出，Attempt events.jsonl 是封存的执行证据段；state.json 和运行中 metadata.json 是可重建投影。各自职责不得混用。

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
| FINALIZING | 非终态 | 执行结果已冻结，正在隔离 Worker、封存证据并幂等提交终态 |
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
└──→ FINALIZING（pendingOutcome=CANCELLED）

PREPARING
├──→ DISPATCHING
├──→ RECOVERING
├──→ CANCELLING
└──→ FINALIZING

DISPATCHING
├──→ RUNNING
├──→ RECOVERING
├──→ CANCELLING
└──→ FINALIZING

RUNNING
├──→ RECOVERING
├──→ CANCELLING
└──→ FINALIZING

CANCELLING
├──→ RUNNING
├──→ RECOVERING
└──→ FINALIZING

RECOVERING
├──→ PREPARING / DISPATCHING / RUNNING / CANCELLING
└──→ FINALIZING

FINALIZING
└──→ SUCCEEDED / FAILED / TIMED_OUT / STALLED / DISCONNECTED / CANCELLED
~~~

规则：

1. 观察到完成、失败、超时、卡死、掉线或取消结果时，必须先以 compare-and-set 进入 FINALIZING，并冻结唯一 observedExecutionOutcome、pendingOutcome 与 finalizationId；同时以 `finalizationStartedAt + Execution Conditions.finalizationTimeout` 一次性计算并持久化 finalizationDeadlineAt，重启不得重算或延长。每个 Attempt 只能原子提交一次终态。
2. QUEUED 等待时间不计入硬执行超时。
3. 硬执行超时从 dispatch ACK 或可证明 Provider 已接受请求时开始。
4. workspace 准备应有独立准备超时，失败映射为 FAILED。
5. UI 与 DSH 的前端连接中断不等于 DISCONNECTED，后端 Attempt 继续运行。
6. Provider 或 Worker 执行通道不可恢复才是 DISCONNECTED。
7. STALLED 前应先出现 NO_PROGRESS_WARNING 健康标记；健康标记不是生命周期状态。
8. 进入 FINALIZING 后停止执行 Watchdog 和用户取消入口，先撤销已签发的 fencing token，并封存可控的 transcript、logs、事件和 workspace 写入。确认终止不能替代 lease 撤销。
9. workspaceSealState=SEALED、archiveCompleteness=COMPLETE 以及“已发布字节不可变”的承诺，还必须满足“底层执行已确认终止”或“所有写入与产物通道已被可验证地隔离”之一。若工具、子进程或直接文件系统写入可以绕过 fencing 且无法终止/撤权，收尾期限到达后只能提交 DISCONNECTED + EXECUTION_ISOLATION_UNRESOLVED，将 workspaceSealState 标为 QUARANTINED_UNSAFE、archiveCompleteness 标为 INCOMPLETE，并继续按 FR-009 保留 reservation；不得发布或声称旧 workspace 已冻结。
10. FINALIZING 使用独立 finalizationDeadlineAt，不计入模型硬执行超时。observedExecutionOutcome=SUCCEEDED 但完成矩阵无法落盘时，最终 state 必须为 FAILED，主 error.code 必须是具体归档失败码，例如 ARCHIVE_WRITE_FAILED、DISK_FULL 或 ARCHIVE_PATH_ESCAPE，archiveError 同步保存归档诊断；不得出现 `state=FAILED, error=null`。
11. PREPARING、DISPATCHING、RUNNING 与 CANCELLING 在宿主重启后进入 RECOVERING；QUEUED 保持排队且不重复创建；已持久化 FINALIZING 的 Attempt 按 finalizationId 和阶段 marker 原地幂等续作，不返回 RUNNING，也不重新 dispatch。
12. RECOVERING 必须有写入 Execution Conditions 的 recovery deadline。到期仍无法确认时先进入 FINALIZING，pendingOutcome=DISCONNECTED、error=RECOVERY_UNRESOLVED，再按规则 8—10 收敛，不能无限显示为运行中。
13. CANCELLING 时若真实执行结果先通过 compare-and-set 冻结为 pendingOutcome，则该结果获胜；取消失败但执行仍健康时可以返回 RUNNING。

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
└──→ SETTLED

SETTLED --Retry / Run Again / Retry Failed→ ACTIVE
~~~

STARTING 表示控制存储已提交 Start 意图、正在发布完整冻结定义。进入 ACTIVE 前不得 dispatch。START_FAILED 必须保证没有任务执行请求。

Stop All 是 Durable Action，不是 Experiment 生命周期。执行 Stop All 时，只要仍有任一非终态 Attempt（包括确认提交后新建且不属于该次冻结目标的 Attempt），Experiment 就保持 ACTIVE；全部 Attempt 终态后才进入 SETTLED。

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
| ATTACHMENT_CONTENT_TRANSFORMED | 否 | Adapter 将对图片做缩放、重压缩、裁剪、转码或其他内容变换 |
| ATTACHMENT_TRANSFORM_UNVERIFIED | 否 | 无法证明 Adapter 不会改变图片内容 |
| INPUT_ENCODING_INVALID | 否 | Prompt、系统提示词或结构化字段不是规范允许的有效 Unicode / I-JSON 输入 |
| INPUT_TOO_LARGE | 否 | 输入超过能力限制 |
| PARAMETER_UNSUPPORTED | 否 | 公共强制参数不受支持 |
| SESSION_ISOLATION_UNSUPPORTED | 否 | 无法证明新 Attempt 不会继承旧 session、记忆或可写运行环境 |
| EXECUTION_ISOLATION_UNSUPPORTED | 否 | 无法证明失联或 orphan 执行不能访问兄弟与后续 Attempt 路径 |
| HARNESS_PROFILE_UNAVAILABLE | 否 | 固定 DSH Harness Profile 不可用 |
| WORKSPACE_NOT_READABLE | 否 | baseline 无法读取 |
| ARCHIVE_NOT_WRITABLE | 否 | 实验目录无法安全写入 |
| CONTROL_STORE_CAPACITY_UNAVAILABLE | 否 | Durable Control Store 不可写或无法预留最小控制容量 |
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
| ARCHIVE_WRITE_FAILED | FAILED 或次级 archiveError | 否 |
| DISK_FULL | FAILED 或次级 archiveError | 否 |
| ARCHIVE_PATH_ESCAPE | FAILED 或次级 archiveError | 否 |
| CANCEL_FAILED | RUNNING、RECOVERING 或 FAILED | 是 |
| RECOVERY_UNRESOLVED | DISCONNECTED | 是 |
| EXECUTION_ISOLATION_UNRESOLVED | DISCONNECTED | 否 |
| START_COMMIT_FAILED | START_FAILED | 是 |
| ACTION_ID_CONFLICT | 原状态不变 | 否 |
| ACTION_TARGET_STALE | 原状态不变 | 是 |
| CONTROL_STORE_UNAVAILABLE | 无法安全推进 | 是 |
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
        ├── definition-index.json
        ├── start.commit
        ├── state.json
        ├── events.jsonl
        ├── objects/
        │   └── <sha256>                 # 完整封存所需的 Experiment 内内容对象
        ├── experiment-seals/
        │   └── <archive-revision>/
        │       ├── settled-state.json
        │       ├── settled-events.jsonl
        │       ├── experiment-archive-index.json
        │       └── seal.commit
        ├── task-package/
        │   ├── task-package.json
        │   ├── prompt.md
        │   ├── attachments/
        │   │   ├── index.json
        │   │   ├── 001-<sha256>.<ext>
        │   │   └── 002-<sha256>.<ext>
        │   └── workspace-baseline/
        │       ├── manifest.json
        │       └── snapshot/ 或指向实验根 objects/ 的内容清单
        └── runs/
            └── <run-ordinal>-<safe-model-slug>-<run-id>/
                ├── run.json
                └── attempts/
                    └── 0001-<attempt-id>/
                        ├── archive-index.json
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
- definition-index.json：Start 时生成的不可变根定义索引，列出 experiment.json、Task Package、Prompt、附件、baseline manifest / 内容对象和全部 run.json 的预期集合与 hash；不包含自身和 start.commit。
- start.commit：包含 definition-index.json 的 hash、Experiment ID、Run 数和提交时间；只有该 marker 与索引、根定义全部校验通过，冻结定义才算发布成功。
- experiment-seals/<archive-revision>/：Experiment 每次进入 SETTLED 时生成的不可变封存候选。settled-state.json 保存 expectedGeneration、semanticEventCursor、auditSequenceAtSnapshot、attemptSetHash 与不含 mutable archive 状态/index 引用的领域快照；settled-events.jsonl 是严格截至 auditSequenceAtSnapshot 的根审计事件副本；experiment-archive-index.json 列出 definition index、全部 Run / Attempt 与两个 settled 快照的 hash；seal.commit 只在 generation CAS 激活流程中写入 activationId 与 index hash。目录存在不等于当前生效，必须同时与 Durable Control Store / live state 的 latest activated revision、generation、semantic cursor 和 attemptSetHash 匹配。
- state.json：可由事件重建的当前聚合状态，使用原子替换。
- Experiment 根 events.jsonl：控制终态提交后的有序审计投影，可从 Durable Control Store 重建，不进入任何 Attempt 的 archive-index。
- task-package.json：冻结的 Task Package、指纹和公共执行条件引用。
- prompt.md：用户 Prompt 的易读副本，不得改变原文。
- attachments/index.json：有序附件清单、MIME、大小、hash 和 DSH 引用。
- workspace-baseline：Experiment 自有、可在外部原 workspace 不存在时独立物化的 baseline 实体；运行中若使用全局内容寻址存储，必须持有保留引用。CURRENT + COMPLETE seal 前还必须把所有所需对象物化到实验根 objects/，外部 store 不属于“仅凭目录还原”的可信边界。
- run.json：一个模型参赛席位与模型配置快照。
- archive-index.json：该 Attempt 按终态和执行阶段计算出的预期文件集合、实际文件 hash、缺失项与完整性结论；终态发布后冻结。
- metadata.json：Attempt 时序、状态、错误、参数、request ID、archiveCompleteness 与指标；运行中是投影，终态提交后冻结。
- effective-input.redacted.json：实际可观察的系统输入、用户输入、附件引用和 Adapter 信息；必须脱敏。
- effective-attachments.json：逐附件记录 sourceHash、effectiveContentHash、无损封装或内容转换链、Adapter 版本及可验证性。
- transcript.jsonl：DSH 会话消息、模型输出、工具调用和工具结果的完整有序记录。
- Attempt events.jsonl：从创建到 FINALIZATION_STARTED 的执行事件段；进入 FINALIZING 后封存并纳入 archive-index。终态提交事件写入 Experiment 根 events.jsonl，不回写已封存段。
- logs.jsonl：Runner、调度、状态转换和诊断日志。
- result.md：模型最终文本输出；一般失败时可以不存在但应有 error.json。若归档目录本身不可写，错误终态由 Durable Control Store 保证，允许 error.json 缺失并标记 archiveCompleteness=INCOMPLETE。
- artifacts：模型或工具产生的用户产物；CURRENT + COMPLETE 时全部字节必须在实验根内，不能只保存外部 URL、临时路径或可失效对象引用。
- workspace：该 Attempt 的独立工作目录或完成快照。

### 13.2.1 Experiment 级归档完整性

Attempt 的 archiveCompleteness 只说明单次执行目录，不能代表整个 Experiment。为避免“是否最新”和“文件是否完整”互相覆盖，Durable Control Store 与 state.json 必须维护两个正交字段：

- experimentArchiveFreshness：CURRENT 或 STALE。CURRENT 表示生效 seal 的 expectedGeneration 与当前 experimentGeneration 相同，且 attemptSetHash 完全一致；ACTIVE、创建新 Attempt 或发生会改变归档解释的终态后控制事件时必须是 STALE。
- experimentArchiveIntegrity：
- COMPLETE：definition-index.json 与 start.commit 相互校验成功；所有冻结根文件和所需 baseline / workspace / artifact 内容对象都位于实验根内且 hash 匹配；当前生效 seal 恰好列出全部 Run 与 Attempt；每个 Attempt archiveCompleteness=COMPLETE 且 index hash 匹配；同 revision 的 settled-events.jsonl、settled-state.json、index 与 commit 均匹配。任何只存在于外部 content store 的引用都会使 integrity 至多为 PARTIAL。
  - PARTIAL：根定义与 start.commit 可验证，但至少一个 Attempt、settled events、settled state、index 或 seal 文件缺失、截断或 hash 不匹配。
  - INCOMPLETE：definition-index、start.commit、experiment.json、Task Package、Prompt、附件、baseline 定义或任一 run.json 缺失/损坏，无法仅凭实验目录确定完整身份与输入。

Start commit 将 experimentGeneration 初始化为 1。attemptSetHash 按 Run ordinal、Attempt number、attemptId 的确定顺序，对当前全部 Attempt 身份使用第 6.4 节同一 JCS + SHA-256 规范计算。每个会改变 Attempt 身份集合或归档解释的控制事务都必须先递增 experimentGeneration、重算或复核 attemptSetHash 并把 freshness 设为 STALE，包括 Start 后创建 Retry / Run Again / Retry Failed，以及 reservation→ORPHANED、安全隔离解除等终态后事件。

auditSequence 对所有控制审计事件单调递增，包括 seal activation 自身；semanticEventCursor 只在 Attempt 集合、领域 settled state、reservation/orphan、安全隔离或其他归档解释发生变化时递增，Seal 内部协议事件不得推进它。Experiment 处于 SETTLED 且控制状态静止时才可尝试生成单调 archiveRevision。Seal Job 必须在同一 Durable Control Store 只读事务中冻结 expectedGeneration、semanticEventCursor、auditSequenceAtSnapshot、对应领域 state、精确 Attempt ID 集合和 attemptSetHash；settled-events.jsonl 只能导出至 auditSequenceAtSnapshot，并与同一切面的 settled-state.json 一起生成不自引用的 experiment-archive-index。settled-state 明确排除 live archive freshness / integrity、latest index hash 等自失效字段。

激活采用两次语义 CAS：先在 `lifecycle=SETTLED && experimentGeneration=expectedGeneration && currentSemanticEventCursor=冻结值 && attemptSetHash=冻结值` 时登记 sealActivationId，freshness 仍为 STALE；该登记产生审计事件并推进 auditSequence，但不推进 generation / semantic cursor。再写入携带 activationId / index hash 的 seal.commit；最后以相同 generation、semantic cursor、set hash 和 activationId 做第二次 CAS，成功后才更新 latest archiveRevision、freshness=CURRENT 与计算出的 integrity。最终激活也可推进 auditSequence，但不得让自身 CAS 失效。任一语义 CAS 失败时该 revision 为 SUPERSEDED 候选，不能更新 latest revision 或 CURRENT；随后到达的旧 Seal Job 也不得覆盖新一代 STALE。发布后才更新 live state.json。只有 CURRENT + COMPLETE 才适用“仅凭整个实验目录还原”的产品承诺；完整性检查独立进行，所以 STALE + INCOMPLETE 等组合都有唯一含义。

### 13.2.2 Attempt archiveCompleteness 完成矩阵

FINALIZING 必须先计算“预期文件集合”并尝试写入 archive-index.json；若归档目标本身不可写，则在 Durable Control Store 中记为 INCOMPLETE，不要求不存在的 index 自证失败。空 transcript、空 logs 和空 artifacts 目录是合法的显式空值，不能用“文件缺失”代替。若 Attempt 在 dispatch 前结束，effective input 与 workspace 项必须以 `available=false` 和原因写入 index / metadata，而不是伪造内容。

| 终态 | COMPLETE 必需项 | 可选项 |
|---|---|---|
| SUCCEEDED | archive-index.json、冻结 metadata.json、effective-input.redacted.json、effective-attachments.json、events.jsonl、logs.jsonl、完整 transcript.jsonl、result.md、workspace 完成快照或实验根 objects/ 内内容对象、artifacts/ 及其所有对象 | error.json 不应存在 |
| FAILED | 通用 index / metadata / events / logs、error.json；若已 dispatch，还必须有 effective input、附件记录与截至终态的 transcript；若 workspace 已物化，还必须有其完成快照或实验根内对象 | 部分 result.md |
| TIMED_OUT / STALLED / DISCONNECTED | 通用 index / metadata / events / logs、error.json、effective input、附件记录、截至终态的 transcript、已物化 workspace 的完成快照或实验根内对象 | 部分 result.md |
| CANCELLED | 通用 index / metadata / events / logs、metadata 中的 cancelReason、截至取消点的 transcript；若已 dispatch，还必须有 effective input 与附件记录；若 workspace 已物化，还必须有其完成快照或实验根内对象 | 部分 result.md；无执行错误时不要求 error.json |

- archive-index.json 列出除自身之外的预期项和 hash；其自身 hash 由 Durable Control Store 终态记录及 Experiment 根审计事件保存，避免自引用 hash。
- COMPLETE：矩阵中的全部预期项已经原子发布，archive-index.json 中的 hash 与实际字节一致，且控制存储记录的 index hash 匹配。
- PARTIAL：Attempt 核心目录、archive-index.json 与冻结 metadata.json 可读，但一个或多个预期项缺失、截断或 hash 不匹配。
- INCOMPLETE：Attempt 核心目录、index 或冻结 metadata 无法发布或验证；权威终态只能从仍健康的 Durable Control Store 读取。
- 只有 archiveCompleteness=COMPLETE 才能进入 SUCCEEDED。其他执行终态遇到归档故障时保留原 TIMED_OUT、STALLED、DISCONNECTED、CANCELLED 或执行 FAILED，并在 archiveError 中另记具体归档失败码；不得覆盖原 error 或 cancelReason。

### 13.3 归档规则

1. experiment.json、Task Package 根文件、全部 run.json、definition-index.json 和 start.commit 必须在任何任务 dispatch 前成功发布并相互校验；发布后其 hash 在运行、Retry 和 Cancel 前后保持不变。
2. Attempt ID、dispatch intent、幂等键和目录必须在 dispatch 前写入 Durable Control Store，防止崩溃后重复提交。
3. RUNNING 期间日志、transcript 和 Attempt 事件采用追加写并带单调序号；进入 FINALIZING 后先写 FINALIZATION_STARTED，再封存这些文件。封存后的迟到数据只进入隔离诊断通道，不得回写已索引文件。
4. 旧 Attempt 永不覆盖。
5. 目录名只使用安全 slug 和稳定 ID，不能直接信任模型名或 Provider 返回的路径。
6. 实验文件默认仅当前本机用户可读写。
7. DSH / 插件管理的 API Key、Authorization Header、Cookie、签名 URL 和 secret 环境变量不得被采集或进入归档；该保证不扩展到用户主动放入 Prompt、workspace 或模型回显的未知秘密。
8. Transcript 可能包含用户数据或模型回显内容；UI 必须提示本地归档风险，不能承诺通用脱敏能消除所有秘密。
9. baseline、workspace 与 artifacts 的归档遍历一律不得跟随符号链接。链接本身可作为受控 metadata 记录；目标越出当前允许根、遍历中发生链接替换竞态或无法以 no-follow 语义验证时，必须以 ARCHIVE_PATH_ESCAPE 失败或标记归档不完整，绝不能读取目标内容。实现必须使用文件描述符相对遍历、O_NOFOLLOW 或平台等价机制，不能只做一次字符串路径检查。
10. finalization 必须按结果型持久阶段幂等执行：`INTENT_RECORDED`（CAS 进入 FINALIZING，冻结 outcome、finalizationId、finalizationDeadlineAt）→ `ISOLATION_RESOLVED`（无论成功或失败都写入 workspaceSealState=SEALED / QUARANTINED_UNSAFE 及原因）→ `ARCHIVE_RESOLVED`（无论发布成功或归档不可写都写入 archiveCompleteness=COMPLETE / PARTIAL / INCOMPLETE、可用时的 index hash 及错误）→ `CONTROL_COMMITTED`（以 finalizationId 在 Durable Control Store 原子提交唯一终态）→ 更新 state.json 并向 Experiment 根 events.jsonl 追加终态审计事件。失败结果也是可推进的 resolved marker，不能伪装成 INPUTS_SEALED / ARCHIVE_PUBLISHED，也不能永久卡在 FINALIZING。任一步崩溃都从原 finalizationId、deadline 与 marker 续作；根事件追加失败可从控制存储重建，不使已封存 index 失效。
11. 归档失败且 Durable Control Store 仍健康时，必须保存原 observedExecutionOutcome、具体 archiveError（如 ARCHIVE_WRITE_FAILED、DISK_FULL、ARCHIVE_PATH_ESCAPE）与 archiveCompleteness=PARTIAL / INCOMPLETE。若原执行已失败、超时、卡死、掉线或取消，保留原主 error / cancelReason，归档问题只作次级 archiveError；若原执行成功，最终改为 FAILED，主 error.code 与 archiveError.code 均使用该具体归档失败码。不能要求不可写目录仍自证完整，也不能显示虚假成功。控制存储自身失败时按 10.6 的 fail-closed 规则处理。
12. Open Experiment Folder 只能打开已登记且经过规范化校验的实验根目录。
13. storage 层只接受持有当前 executionLeaseId 与 fencingToken 的写入；FINALIZING 后迟到 Worker 写入被拒绝到独立诊断通道。无法拦截的直接写入会使 workspaceSealState=QUARANTINED_UNSAFE 且归档不得标 COMPLETE。

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
- 路径 sandbox 必须在 execution lease 之外独立成立：即使旧进程失联、token 已撤销但进程仍存活，它也不能发现或写入兄弟与后续 Attempt 的目录。
- Retry 不继承上一次的文件、缓存、进程、session、临时目录或环境变量变更。
- 每个进入 session / workspace 创建路径的新 Attempt 都必须获得不复用的 dshSessionId、workspacePath、可写实体身份、受控临时目录和按 allowlist 构造的环境；首条上下文不得含任一旧 Attempt 的 transcript、记忆或模型输出。物化前终态允许这些字段为空，但必须有原因。旧后台进程必须已终止或被验证无法访问新 workspace 与写入通道。
- 上述隔离只承诺插件与 DSH 可控范围，不虚构 Provider 服务端不可观察的缓存状态；若 DSH 无法证明可控 session / 环境隔离，则以 SESSION_ISOLATION_UNSUPPORTED 阻止开始。
- baseline 必须在原 workspace 被移动或删除后仍可从 Experiment 自有存储独立物化。
- 旧 execution lease 被撤销后，迟到 Worker 不得改变历史 Attempt 目录的任何已发布字节。

### NFR-003：可靠性与恢复

- 所有控制状态更新必须由 Durable Control Store 事务提交；审计事件追加持久化，投影使用原子替换。
- Start、Retry、Run Again、Retry Failed、Stop 和 Stop All 必须幂等。
- 应用重启不能造成重复 Provider 请求。
- FINALIZING 必须以 finalizationId 和持久阶段 marker 幂等恢复；应用重启不得把它退回 RUNNING、重复归档或遗漏终态审计。
- 恢复不了的执行状态必须转为明确终态，不得永久显示为 Running；无法安全封存的 workspace 必须显式标 QUARANTINED_UNSAFE / INCOMPLETE，而不是虚假完成。
- 磁盘空间不足、权限错误和半写文件必须显式报告。
- 归档目标失败但预留的 Durable Control Store 仍健康时，控制存储必须保存终态、错误码和完整性标记。
- Start 及每个创建后续 Attempt 的 Action 都必须先在同一事务中预留足够提交新 Attempt 最坏情况下控制终态的容量；预留失败则对应操作零创建。控制存储自身不可写时停止新 dispatch，尽力停止或隔离现有执行并显式报告持久状态未知，不得谎称已经落盘。

### NFR-004：实时性

- DSH 返回本地模型列表后，正常条件下 2 秒内完成页面呈现。
- 正常 UI 条件下，点击 Start 后 300 毫秒内先显示本地“正在提交”反馈；该反馈不冒充已持久化。Durable Control Store 接受 Start intent 后显示带 experimentId 的 STARTING；只有 Start commit 完成并进入 ACTIVE 后才显示各 Attempt 的 QUEUED / PREPARING。大附件与 baseline 冻结耗时不受 300 毫秒承诺约束，但必须持续显示阶段与可行动错误，不能假死。
- 持久化运行事件到 UI 的正常 P95 延迟不超过 1 秒。
- 页面重载后 5 秒内恢复可确认状态或显示 RECOVERING。

### NFR-005：容量与并发

- UI 和存储结构必须支持至少 10 个模型 Run 的单个 Experiment。
- 默认并发 min(4, N)，实际最大值受 DSH 安全上限约束。
- 任意时刻 executionReservationState=HELD 的记录不得超过设置值；reservation 可以跨越 PREPARING、DISPATCHING、RUNNING、RECOVERING、CANCELLING、FINALIZING，甚至延续到控制终态后的保守保留期，不能只按 UI state 计数。
- 图片数量、单图大小和总大小不另造限制，直接继承 DSH 可验证限制并在 UI 预先展示。
- 长日志可虚拟化展示，但不能截断磁盘证据。

### NFR-006：安全与隐私

- V1 默认本地保存，不启用未声明的遥测、云同步或上传。
- 创建实验前提示 Prompt、图片和 workspace 内容会发送给所选 Provider。
- 图片必须校验真实 MIME 与内容，不只信任扩展名。
- 所有路径必须规范化并防止目录穿越。
- workspace snapshot 不得跟随越界符号链接。
- baseline、运行后 workspace 和 artifacts 的所有归档遍历都不得跟随符号链接读取目标；必须防御 symlink swap / TOCTOU，越界或无法验证时以 ARCHIVE_PATH_ESCAPE 大声失败。
- DSH / 插件管理的凭据、认证 Header、Cookie、Token 和 secret 环境变量不得被采集或归档；写盘前还必须扫描已知敏感字段。用户内容中的未知秘密只能提示风险，不能以通用脱敏作绝对保证。
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

**Given** DSH 已配置 3 个模型，其中 2 个支持图片<br>
**When** 用户打开 Model PK 并刷新<br>
**Then** 页面准确展示 3 个稳定配置项及 Provider、Model ID、显示名和图片能力，且插件没有静态或手工模型旁路。

### AC-002：模型配置变化

**Given** 创建页已经加载模型列表<br>
**When** DSH 新增、删除或禁用一个配置并点击刷新<br>
**Then** 创建页反映最新列表；已选但失效的配置被保留并标红、Preflight 失效，直到用户移除或恢复；已冻结 Experiment 不被静默修改。

### AC-003：创建输入校验

**Given** 少于 2 个模型、Prompt 为空或 Concurrency 越界<br>
**When** 用户尝试 Preflight<br>
**Then** 操作被阻止，并对每个字段显示具体原因。

### AC-004：统一 Prompt

**Given** Prompt 含前后空格、多行和 Unicode<br>
**When** 选择 3 个模型开始实验<br>
**Then** 3 个首个 Attempt 的 Prompt 原文与 hash 完全一致，未发生 trim、换行规范化或模型专属改写。

### AC-005：三种图片添加方式

**Given** 用户分别通过选择文件、拖拽和粘贴添加 3 张图片<br>
**When** 查看附件区与最终 manifest<br>
**Then** 三张图片均从 UPLOADING 进入 READY，并有缩略图、编号、MIME、大小和 hash，且 UI 顺序与 attachments/index.json 一致。

### AC-006：附件变更使 Preflight 失效

**Given** Preflight 已通过<br>
**When** 用户删除、增加或调整任一图片顺序<br>
**Then** Preflight 立即回到 NOT_CHECKED，Start PK 禁用，必须重新检查。

### AC-007：图片能力阻断

**Given** Task Package 含图片，选中模型中有一个不支持 image input<br>
**When** 运行 Preflight<br>
**Then** 对该模型显示 IMAGE_INPUT_UNSUPPORTED，整个 Experiment 不能开始；任务执行请求、用户 Prompt 请求、DSH session 和 Attempt 数均为 0。允许并记录不携带用户任务的健康检查请求。

### AC-008：不允许图片静默降级

**Given** 某模型只支持文本<br>
**When** 用户包含图片<br>
**Then** 系统不执行 OCR、不调用辅助视觉模型、不丢弃图片，也不只发送 Prompt。

### AC-009：Provider Preflight

**Given** 一个 Provider 未配置、一个鉴权失败、一个无法验证实时可用性<br>
**When** 运行 Preflight<br>
**Then** 前两个分别显示稳定 BLOCKED 错误码，第三个显示明确 WARNING；WARNING 未确认前 Start 禁用，确认后只对该 Preflight 快照有效；不创建任何 Attempt。

### AC-010：冻结后只读

**Given** Experiment 已 Start<br>
**When** 用户查看创建输入或使用任一重跑入口<br>
**Then** Prompt、图片、模型集合、baseline 和执行条件均为只读，界面不存在修改入口。

### AC-011：Experiment、Run、Attempt 数量

**Given** 选择 N 个模型并首次开始<br>
**When** Experiment 冻结成功<br>
**Then** 同一 startActionId 的逻辑提交创建 1 个 Experiment、恰好 N 个 Run、每个 Run 恰好 1 个 INITIAL Attempt 和 N 个入队意图；没有部分可见状态。

### AC-012：相同指纹

**Given** 一个正常启动的 Experiment<br>
**When** 检查所有 Attempt metadata<br>
**Then** taskPackageHash、resolvedHarnessFingerprint、executionConditionsHash 和各自 modelConfigFingerprint 均与冻结值相同；源附件字节与顺序相同，effectiveAttachments 可证明没有内容级差异。

### AC-013：受控并发

**Given** N=5，Concurrency=2<br>
**When** 5 个初始 Attempt 运行，且其中一路进入 CANCELLING、另一路进入 RECOVERING<br>
**Then** Durable Control Store 中 executionReservationState=HELD 的记录始终不超过 2；FINALIZING 或已终态但底层未确认终止的 Attempt 仍可持有 reservation，其余显示 QUEUED。分别在 PREPARING 尚无 intent、ACK 未落盘、ACK 已落盘时崩溃，系统按冻结的 preparing、intent、ACK 三段公式恢复同一且只单调延后的 release deadline；超期后原子标 ORPHANED 并展示警告，不把它伪装成已确认停止，也不承诺此后外部 Provider 的实际活跃请求数仍不超过 2。

### AC-014：QUEUED 不计执行超时

**Given** 最后一路在队列等待超过硬执行时限<br>
**When** 它尚未 dispatch<br>
**Then** 不进入 TIMED_OUT；硬执行计时从 dispatch ACK 或可证明 Provider 接受请求时开始。

### AC-015：workspace 相互隔离

**Given** 两个模型并行运行<br>
**When** Run A 在自己的 workspace 写入唯一标记文件<br>
**Then** Run B 无法读取该文件，且兄弟 Run 的输出不出现在 Run B workspace。

### AC-016：Retry 使用干净 workspace

**Given** Attempt 1 写入临时文件后失败<br>
**When** 用户点击单路 Retry，Attempt 2 进入 session 与 workspace 物化阶段<br>
**Then** Attempt 2 的 baseline hash 与 Attempt 1 相同，但 dshSessionId、workspacePath、可写实体身份和临时目录均不同；首条上下文不含 Attempt 1 的 transcript、记忆或模型输出，Attempt 1 创建的文件、缓存、后台进程与环境变量变化均不可见；Attempt 1 的 lease 已撤销，持旧 token 的迟到写入被拒绝，Attempt 1 已发布目录保持字节不变。

### AC-017：单路 Retry

**Given** 一个 Run 最新 Attempt 为可重试 FAILED，其他 Run 已成功<br>
**When** 用户点击该 Run 的 Retry<br>
**Then** 仅该 Run 新增一个 RETRY Attempt，其他 Run 不变，且新 Attempt 受原并发限制；若注入控制容量不足，则返回 CONTROL_STORE_CAPACITY_UNAVAILABLE，Attempt、目录和入队意图均零创建。

### AC-018：成功单路 Run Again

**Given** 一个 Run 最新 Attempt 已 SUCCEEDED<br>
**When** 用户点击 Run Again 且新 Attempt 进入 session 创建阶段<br>
**Then** 同一 Run 新增一个 RUN_AGAIN Attempt，复用冻结输入和执行条件并获得与所有旧 Attempt 不同的 dshSessionId 和可写环境；旧成功结果仍可查看。

### AC-019：Retry Failed

**Given** 最新状态分别为 SUCCEEDED、FAILED、TIMED_OUT、STALLED、DISCONNECTED、CANCELLED 和正在 RUNNING 的 7 个 Run<br>
**When** 用户确认 Retry Failed<br>
**Then** 在一个控制存储事务中整体预留容量，并只为可重试的 FAILED、TIMED_OUT、STALLED、DISCONNECTED 各新增一个 Attempt；其他 Run 不变，并记录同一 batchActionId。任一冻结目标 stale 或批量容量不足时，本批次零创建。

### AC-020：重跑配置漂移

**Given** Experiment 冻结后模型配置、DSH Runtime、Agent Loop、系统提示词、工具 schema、权限或 Adapter 任一发生变化<br>
**When** 用户点击 Retry 或 Run Again<br>
**Then** 系统以 MODEL_CONFIG_DRIFT、HARNESS_PROFILE_DRIFT、RUNTIME_VERSION_DRIFT 或 ADAPTER_VERSION_DRIFT 阻止新 Attempt，不静默使用新条件。

### AC-021：重跑幂等

**Given** 网络重复提交同一个 Action，或单路 Retry 与 Retry Failed 竞争同一 Run<br>
**When** 后端收到请求<br>
**Then** 相同 operationId 只执行一次；不同 ID 竞争时 compare-and-set 只允许一个成功，另一方返回 ACTION_TARGET_STALE，每个 Run 最多一个非终态 Attempt。

### AC-022：失败、卡死、掉线、超时分类

**Given** 测试适配器分别注入一般 Provider 错误、无有效进展、执行流断开和硬时限到达<br>
**When** Attempt 结束<br>
**Then** 状态分别为 FAILED、STALLED、DISCONNECTED、TIMED_OUT，并有相匹配的结构化 error.code，不能统一显示为 FAILED。

### AC-023：浏览器掉线不影响执行

**Given** Attempt 在后端 RUNNING<br>
**When** 浏览器断网或页面关闭后恢复<br>
**Then** 后端继续执行；重连后状态和日志补齐且无重复，Attempt 不因前端掉线进入 DISCONNECTED。

### AC-024：单路 Stop

**Given** 一个 Run 正在高频输出、更新 heartbeat / lastProgressAt 与日志，其他 Run 也在运行<br>
**When** 用户以当前 attemptId + expectedLifecycleVersion Stop 目标 Run<br>
**Then** 非生命周期更新不改变 lifecycleVersion，Stop 不误报 stale；目标进入 CANCELLING，再以 pendingOutcome=CANCELLED 进入 FINALIZING 并最终成为 CANCELLED，其他 Run 继续，历史日志和产物保留。

### AC-025：Stop 与 Stop All 精确目标

**Given** Experiment 同时有成功、失败、排队和运行中的 Attempt<br>
**When** 用户确认提交 Stop All，后端在该瞬间冻结每个目标 attemptId 与 expectedLifecycleVersion；其中一个旧 Attempt 在请求延迟期间结束，同一 Run 又启动新 Attempt<br>
**Then** 只对冻结时的 QUEUED、PREPARING、DISPATCHING、RUNNING、RECOVERING 目标取消；QUEUED 直接进入 FINALIZING，其他执行态先进入 CANCELLING，已 CANCELLING 的目标幂等不重复；旧目标返回幂等结果或 ACTION_TARGET_STALE，新 Attempt 不被取消，Experiment 在新 Attempt 非终态期间保持 ACTIVE。单路 Stop 遵守同一精确目标规则。

### AC-026：取消与完成竞态

**Given** 完成事件和取消确认几乎同时到达<br>
**When** 状态持久化<br>
**Then** 只有第一个原子冻结的 pendingOutcome 生效，Attempt 进入一次 FINALIZING 并只提交一个终态；迟到事件只进入诊断日志。

### AC-027：实时日志

**Given** 模型和工具持续产生事件<br>
**When** UI 正常在线<br>
**Then** 事件按序显示，正常 P95 延迟不超过 1 秒；暂停自动滚动不影响磁盘持续归档；任意状态组合下 Queued + Active + Finalizing + Finished 始终等于 Run 总数，FINALIZING 不计入 Running/Active 且 Stop、Retry、Run Again 均禁用。

### AC-028：Attempt 历史

**Given** 一个 Run 有 3 个 Attempt<br>
**When** 打开 Run 详情<br>
**Then** 默认显示 Attempt 3 of 3，并可切换查看前两个 Attempt 的 Output、Logs、Transcript、Artifacts 和 Metadata。

### AC-029：完整归档

**Given** 一个 Experiment 的 Attempt 分别以 SUCCEEDED、FAILED、TIMED_OUT、STALLED、DISCONNECTED 和 CANCELLED 结束<br>
**When** 所有 Attempt 进入终态且 archiveCompleteness=COMPLETE<br>
**Then** 每个 Attempt 严格满足 13.2.2 对应行的预期文件集合，archive-index.json 的 hash 全部匹配且不自引用；SUCCEEDED 有 result.md，执行错误终态有 error.json，CANCELLED 有 cancelReason 且无需伪造 error.json，dispatch 前失败以显式 `available=false` 说明未生成项；Attempt events.jsonl 在 FINALIZATION_STARTED 后不再变化，终态审计位于可重建的 Experiment 根 events.jsonl。definition-index、start.commit、Prompt、附件、baseline、workspace、artifacts 所需全部内容对象和全部 run.json 均位于实验根内并校验通过，最新生效 revision 的 settled-state、settled-events、experiment-archive-index 与 seal.commit 恰好覆盖全部 Attempt 后，freshness 才为 CURRENT 且 integrity 为 COMPLETE；live state.json 后续更新不改变已封存 hash。任一根文件/对象缺失、仍只在外部 store 或 hash 不匹配时，即使所有 Attempt 均 COMPLETE，Experiment integrity 也不得为 COMPLETE。

**Given** Seal Job 已在同一快照冻结 generation、semantic cursor、auditSequenceAtSnapshot、Attempt 集合与 set hash<br>
**When** 分别在快照后、候选目录发布后和第一次 activation CAS 后并发创建 Retry / Retry Failed，或提交 reservation→ORPHANED 事件<br>
**Then** archive-relevant 控制事务递增 generation / semantic cursor 并置 freshness=STALE；旧 Seal Job 的 activation 或最终 CAS 失败，候选标为 SUPERSEDED 且绝不覆盖 latest revision / CURRENT；系统只对新一代一致切面重新封存。第一次 activation 与最终激活自身产生的审计事件只递增 auditSequence，合法 Seal 仍能完成语义 CAS。

### AC-030：归档无凭据

**Given** DSH 使用 API Key、Authorization Header、Cookie 或签名 URL<br>
**When** 扫描完整实验目录<br>
**Then** 不存在从 DSH / 插件 secret store、认证请求字段或 secret 环境变量采集的明文凭据，已知敏感字段均已脱敏；测试另在用户 Prompt 中主动放入标记秘密时，UI 已提示内容归档风险，系统不宣称一定能识别或删除该用户内容。再让模型在 workspace / artifacts 中创建指向实验外 secret 的符号链接并并发替换，归档器不读取目标字节，返回 ARCHIVE_PATH_ESCAPE 或明确不完整归档。

### AC-031：一键打开目录

**Given** Experiment 目录存在<br>
**When** 点击 Open Experiment Folder<br>
**Then** V1 在 macOS 中由 Finder 打开准确的实验根目录。目录缺失或无权限时，显示具体错误并允许复制原登记路径。

### AC-032：宿主重启恢复

**Given** 分别有 Attempt 处于 PREPARING、DISPATCHING、RUNNING、CANCELLING 和 FINALIZING 各持久阶段时 DSH 宿主重启<br>
**When** 插件恢复<br>
**Then** 不重复 dispatch；QUEUED 保持排队，执行态进入合法 RECOVERING 路径；FINALIZING 按同一 finalizationId 从 marker 原地续作，不退回 RUNNING、不重复 result / index / 终态；可重连则续接，不可确认则在 recovery deadline 后经 FINALIZING 明确为 DISCONNECTED。

### AC-033：单路故障隔离

**Given** N 个 Run 中一路 workspace 准备失败<br>
**When** 该路进入 FAILED<br>
**Then** 其他已 dispatch 或排队的 Run 按正常策略继续，不被连带终止。

### AC-034：V1 范围检查

**Given** 完成的 V1 UI、接口、配置和数据结构<br>
**When** 做发布审查<br>
**Then** 不存在自动 Judge、自动评分、Elo、排行榜、Codex CLI、Claude Code CLI、Agent Router、Prompt 模板库或批量 Benchmark 执行路径。

### AC-035：固定 DSH Harness

**Given** 选择多个模型运行同一 Experiment<br>
**When** 比较每个 Attempt 的 effective input 与 Harness metadata<br>
**Then** Agent Loop、逻辑系统提示词、工具清单、工具描述、权限和公共限制一致；只有 base64、multipart 等无损协议封装可以不同。任何模型专属 Prompt 改写或图片内容转换都会阻断或失败。

### AC-036：模型选择器页面状态

**Given** 模型注册表分别处于加载中、空列表、读取失败和刷新中<br>
**When** 打开或操作选择器<br>
**Then** 分别显示 LOADING、EMPTY、ERROR、REFRESHING；EMPTY 与 ERROR 不能进入 Preflight，ERROR 提供 Retry，且页面不假装返回空的成功列表。

### AC-037：附件上传门禁

**Given** 一张图片仍为 UPLOADING，另一张为 FAILED<br>
**When** 用户点击 Preflight<br>
**Then** 操作被阻止；上传完成并进入 READY、且失败项被删除或重传成功后才允许检查。

### AC-038：Preflight 状态与失效矩阵

**Given** Preflight 依次处于 NOT_CHECKED、CHECKING、BLOCKED、WARNING、READY<br>
**When** 观察 Start PK<br>
**Then** 只有 READY 或对当前快照已确认的 WARNING 启用；修改 Task Name、Prompt、模型集合、附件或顺序、workspace baseline、Concurrency、Resolved Harness 任一项都会清除结果和 WARNING 确认。

### AC-039：最终实际输入预览

**Given** Preflight 即将通过<br>
**When** 用户查看实际输入摘要并 Start<br>
**Then** 预览中的 Prompt、系统提示词、附件顺序与 hash、baseline、工具、权限、模型快照和公共执行参数与最终 experiment.json 逐项一致。

### AC-040：Start 事务与幂等恢复

**Given** 分别在写入 manifest 后、创建第 k 个 Run 后和入队前注入崩溃，并重复提交相同 startActionId<br>
**When** 系统恢复<br>
**Then** 要么完成同一个含 N 个 Run 与 N 个 INITIAL Attempt 的提交，要么进入 START_FAILED 且零任务 dispatch；不会出现部分可运行 Experiment、重复 Run 或重复 Attempt。

### AC-041：dispatch 崩溃窗口

**Given** 分别在请求发送前、DSH 接受后但 ACK 未落盘、ACK 落盘后注入崩溃<br>
**When** 系统恢复<br>
**Then** 支持幂等查询时续接同一请求；无法查询的未确认窗口进入 RECOVERING 并最终经 FINALIZING 收敛为 DISCONNECTED + RECOVERY_UNRESOLVED，绝不自动重发用户任务；重启前后的 executionReservationState、reservationReleaseDeadline 和计数一致，ACK 未落盘时使用冻结的保守公式，不会因恢复丢槽而超发。

### AC-042：统一 FIFO 队列

**Given** 仍有初始 Attempt 在 QUEUED 时，用户触发单路 Retry 和一次 Retry Failed<br>
**When** 调度器接收新 Attempt<br>
**Then** 已有队列顺序不变；单路操作追加队尾，批量目标按 Run ordinal 排序后整体追加，不抢占活动任务。

### AC-043：图片内容转换可检测

**Given** 一个测试 Adapter 会只为某一路缩放或重压缩图片，或既无 effectiveContentHash 也无版本锁定的 lossless contract<br>
**When** Preflight 可预知该行为，或运行时产生 effectiveAttachments<br>
**Then** Preflight 分别以 ATTACHMENT_CONTENT_TRANSFORMED 或 ATTACHMENT_TRANSFORM_UNVERIFIED 硬阻断；若只能运行时发现内容变化，则 Attempt 以 ATTACHMENT_CONTENT_TRANSFORMED 失败，不能作为公平结果完成。

### AC-044：自包含 workspace baseline

**Given** Experiment 已冻结，随后原 workspace 和 DSH 临时 snapshot 引用被移动或删除<br>
**When** 对任一 Run 执行 Retry<br>
**Then** 仍能从 Experiment 自有内容存储物化 hash 完全相同的 baseline；Experiment 要进入 archive CURRENT + COMPLETE 时，所有 baseline / workspace / artifact 对象还必须位于实验根 objects/ 并纳入 seal。若实体损坏或仍仅有外部引用，则在 dispatch 前明确失败或将 Experiment integrity 降为 PARTIAL / INCOMPLETE。

### AC-045：不可变定义与可重建投影

**Given** Experiment 经历运行、Retry、Run Again、Cancel 和结果变化<br>
**When** 比较文件并删除 state.json 后重建<br>
**Then** experiment.json 与 run.json 的 hash 始终不变；重建后的 lifecycle、outcome、latestAttemptId、成功引用和计数与删除前一致。

### AC-046：归档写入失败

**Given** 分别向归档目标注入磁盘满、权限撤销、result 半写或 transcript 尾部损坏，并另测 Durable Control Store 自身不可写<br>
**When** Attempt 收尾<br>
**Then** 在预留控制容量仍健康的场景，Durable Control Store 保存 observedExecutionOutcome、具体 archiveError 及 archiveCompleteness=PARTIAL / INCOMPLETE；原执行成功时最终必须是 FAILED 且主 error.code 非空并等于 ARCHIVE_WRITE_FAILED、DISK_FULL、ARCHIVE_PATH_ESCAPE 等实际归档错误码。在 INTENT_RECORDED、ISOLATION_RESOLVED、ARCHIVE_RESOLVED、CONTROL_COMMITTED 任一阶段及归档完全不可写/隔离失败分支注入崩溃后，均以同一 finalizationId、finalizationDeadlineAt 幂等收敛，结果型 marker 诚实记录失败且 sealed 文件 hash 不变；控制存储自身不可写时停止新 dispatch、尽力撤销 lease 并显示“持久状态未知”，测试不得要求一个不可写的事实来源仍成功保存终态。

### AC-047：取消失败与恢复

**Given** 取消命令分别出现“失败但执行仍健康”“失败且执行状态未知”“取消中模型先完成”，并在 CANCELLING 时注入宿主重启<br>
**When** 状态收敛<br>
**Then** 分别回到 RUNNING、进入 RECOVERING 后明确恢复或经 FINALIZING 成为 DISCONNECTED、由 pendingOutcome=SUCCEEDED 获胜并只提交一次终态；重启后不会永久 CANCELLING、重复取消或重复收尾。

### AC-048：指纹跨进程稳定

**Given** 同一 Task Package 和 Harness 快照在进程重启后重新载入<br>
**When** 按 canonical 规则重算所有指纹<br>
**Then** 所有模块使用 RFC 8785 + SHA-256 得到与冻结值一致的结果；仅改变对象键枚举顺序或 base64 / multipart 封装不会误报漂移，而改变 Prompt 字节、附件内容、系统提示词或工具 schema 必然改变相应指纹；缺失字段与 null 不等价，非法代理项、非有限数字和超范围整数被明确拒绝；Action requestHash 使用同一规范。

### AC-049：原始结果对照

**Given** N 个 Run 已进入终态，其中包含成功和失败<br>
**When** 打开原始输出对照区<br>
**Then** 按用户模型选择顺序展示每路最新 Attempt；成功显示原始输出，失败显示明确占位与错误入口，不进行评分、胜负排序或自动重排。

### AC-050：终态写入栅栏

**Given** 旧 Worker 在 Attempt 已 STALLED、DISCONNECTED 或 CANCELLED 后继续通过受 fencing 的通道发送事件与文件写入，且 replacement isolation 可证明<br>
**When** reservation 释放后创建并 dispatch 新 Attempt<br>
**Then** 旧 token 的写入被拒绝到隔离诊断通道，旧 Attempt 已 SEALED 的发布文件和新 Attempt workspace 均不被修改；若仅外部 Provider 终止未确认，UI 明确提示 orphan 与可能继续计费。

**Given** 测试 Worker 可以绕过 storage，且无法终止、撤权或证明 replacement isolation<br>
**When** 用户尝试 Retry<br>
**Then** 新 Attempt、目录和入队意图均零增长，操作以 EXECUTION_ISOLATION_UNRESOLVED 阻断；旧 workspace 标为 QUARANTINED_UNSAFE、归档 INCOMPLETE，系统不宣称历史字节已冻结。

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
11. macOS 上通过 DSH 或宿主正式接口打开 Finder 的具体 API 与错误映射。
12. Provider 模型别名能否解析到真实 revision。

每个待确认项都必须在技术设计或兼容性报告中得到结论。若结论影响公平性、归档或恢复，必须在开始对应模块实现前解决。

---

## 19. 推荐实现顺序

遵循最小端到端、逐层验证原则：

### Stage 0：DSH Compatibility Spike

- 只验证模型枚举、配置 ID、能力查询、session、流式事件、附件、取消、workspace 和 UI 扩展点。
- 必须验证 dispatch 幂等键或按键查询能力；若 DSH 不支持，技术设计必须采用“未知窗口不自动重发”的恢复路径。
- 必须证明可以解析并冻结实际系统提示词、Agent Loop、工具 schema、权限和 Adapter 版本，形成 resolvedHarnessFingerprint。
- 必须证明每个进入 session / workspace 创建路径的 Attempt 都获得不复用的 dshSessionId、首条上下文无历史 transcript / 记忆、可写 workspace / 临时目录 / 环境隔离且旧后台进程不能写入新 Attempt；物化前终态须留下 available=false 原因。否则以 SESSION_ISOLATION_UNSUPPORTED 关闭 V1 执行路径。
- 必须以失联且拒绝退出的测试 Worker 证明旧执行无法访问兄弟或后续 Attempt 路径；失败时以 EXECUTION_ISOLATION_UNSUPPORTED 阻断，不得依赖“通常会退出”。
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
2. AC-001 至 AC-050 全部通过。
3. 对受支持 DSH 版本完成真实 Provider 集成测试。
4. 失败、卡死、掉线、超时、取消和恢复均有可重复测试。
5. Retry、Run Again、Retry Failed 的语义、幂等性和 workspace 清洁性有自动化测试。
6. manifest、Prompt、附件、metadata、transcript、日志和产物目录均经人工抽查。
7. 完整归档通过 DSH / 插件管理凭据与已知敏感字段扫描，并对用户内容中的未知秘密保留明确风险说明。
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
