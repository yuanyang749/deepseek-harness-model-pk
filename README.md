# Model PK for DeepSeek Harness

Model PK 是 DSH `0.1.1-rc.2` 的本地多模型公平对照插件。它以一个冻结的 Task Package 和 Harness 同时运行 2–10 个模型，并持久化完整的 `Experiment → Run → Attempt` 生命周期、实时输出、重跑、恢复、归档和删除操作。

## V1 功能

- 设置页 Model PK 入口打开全屏 UI：创建、Preflight、Experiment 详情、Attempt 历史、双栏原始输出对照、本地存储管理。
- 单个 ACTIVE Experiment；实验内持久 FIFO 调度，默认并发 `min(4, N)`。
- 文本、最多 10 张原始图片、最多 5 GiB / 200,000 文件的完整 Baseline 快照。
- `Stop`、`Stop All`、`Retry`、`Run Again`、原子 `Retry Failed`。
- 执行会话按 `PK · 实验名 · 模型名` 保留；实验页可按模型与 Attempt 返回 DeepSeek 会话查看完整执行过程。
- 实验报告汇总状态、耗时、首次响应、请求数、输入/输出/缓存 Token、产物与重试次数；用户可拖拽设置人工质量顺序，并导出带实验名称和时间的 PNG 报告。
- Host 崩溃后的 STARTING、执行未知窗口、FINALIZING 和 Seal 收敛。
- 插件专属 SQLite（`BEGIN IMMEDIATE`、`synchronous=FULL`、CAS、partial unique indexes）。
- Rust 平台原生 no-follow 文件边界（macOS `openat/fstatat`、Windows handle/reparse 检查）、内容寻址快照、fencing token、物理预分配双缓冲控制 slot。
- macOS deny-default Seatbelt 或 Windows AppContainer；仅允许读写本次 Attempt workspace，使用独立 HOME/TEMP，允许出站联网，并以进程组 / Job Object 收敛整棵子进程树。
- 自包含归档、不可变 Seal、Finder / Explorer 打开和 Durable Delete receipt。

V1 不包含自动评分、自动质量排名、Judge、Elo、跨实验排行榜、批量 Benchmark 或外部 Agent CLI。实验报告中的质量顺序完全由用户人工评定，仅保存在本机，不会自动选择“最佳模型”或改变实验结果。

## 固定版本

- DSH: `0.1.1-rc.2`
- DSH source commit: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Node: `^22.19 || >=24`
- macOS: arm64 / x64 原生可选包
- Windows: arm64 / x64 原生可选包

Windows 的运行数据根目录需位于支持 ACL 的本地卷；启动时的 Compatibility Gate 会实际验证 AppContainer 的 workspace 读写、出站联网、越界拒绝与孤儿进程清理，而不是仅按系统版本放行。

版本、Adapter、图片 wire path、session 新鲜度、隔离、归档和控制容量均由启动时 Compatibility Gate 动态证明；阻断项会保留 UI 查询能力并关闭 Start。

pi-ai 内置模型的 wire protocol、上下文与输出 token 能力来自锁定的 `@earendil-works/pi-ai@0.82.1` catalog；自定义 route 从脱敏 profile 解析。Preflight 诊断会展示这些能力、Serializer 依赖与最终 fingerprint，公共输出能力低于 8192 时直接阻断。

## 开发与验证

```bash
corepack enable
pnpm install
pnpm build:native
pnpm check
```

完整自动化检查同时覆盖 macOS 与 Windows：TypeScript strict typecheck、领域/SQLite/RPC/UI 测试、Rust helper 真实文件系统测试，以及 Seatbelt 或 AppContainer/Job Object hostile-orphan 隔离测试。Windows 开发机需要 Rust MSVC toolchain；`pnpm build:native` 会自动产出当前系统/架构的可选包。

## 从 npm 安装到 DSH Web Profile

```bash
dsh plugin --profile web add @yuanyang749/dsh-model-pk
dsh --profile web
```

包管理器会根据当前系统自动安装对应的 `@yuanyang749/model-pk-native-*` 原生包。当前支持 macOS arm64 / x64 和 Windows arm64 / x64。四个平台包由 GitHub Actions 在对应 runner 上构建；推送 `v*` tag 会自动发布到 npm。

本地开发版本可使用：

```bash
pnpm dsh:bootstrap -- --profile web
pnpm exec dsh --profile web
```

插件只增加：

- Host RPC `/model-pk` 与 `/model-pk-native`，均为 loopback authority；
- `settings.section` 的 Model PK 入口；
- `shell.overlay` 的全屏产品界面。

它不会替换 DSH 的 conversation UI。

运行后的权威 Compatibility 报告位于：

```text
$DSH_HOME/model-pk/v1/control/compatibility-report.json
$DSH_HOME/model-pk/v1/control/compatibility-report.md
```

查看并用非零退出码表达 BLOCKED：

```bash
pnpm compat
```

## 数据布局

```text
$DSH_HOME/model-pk/v1/
├── control/
│   ├── control.sqlite
│   ├── capacity/slot-*.journal
│   └── compatibility-report.{json,md}
├── drafts/
├── experiments/YYYY-MM-DD/<experiment-id>-<slug>/
├── runtime/<experiment-id>/<attempt-id>/
└── trash/
```

macOS 使用目录 `0700`、文件 `0600`；Windows 使用用户 ACL 与 Attempt 专属 AppContainer ACL。Experiment 永久保留，只能在 SETTLED 且没有进行中 Action 时手动删除。

## 关键实现入口

- Host 生命周期：`src/host/runtime.ts`
- RPC 边界：`src/host/rpc-router.ts`
- 调度与恢复：`src/host/scheduler.ts`
- SQLite 控制面：`src/storage/store.ts`
- 固定 Harness：`src/host/harness.ts`
- 原生 helper：`native/model-pk-helper/src/{unix,windows}.rs`
- 正式 UI：`src/client/App.tsx`
- 兼容与发布证据：`docs/COMPATIBILITY_REPORT.md`

## 许可证

[MIT](LICENSE)
