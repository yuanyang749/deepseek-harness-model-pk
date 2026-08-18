# Model PK for DeepSeek Harness

Model PK 是 DSH `0.1.0-rc.7` 的本地多模型公平对照插件。它以一个冻结的 Task Package 和 Harness 同时运行 2–10 个模型，并持久化完整的 `Experiment → Run → Attempt` 生命周期、实时输出、重跑、恢复、归档和删除操作。

## V1 功能

- 设置页 Model PK 入口打开全屏 UI：创建、Preflight、Experiment 详情、Attempt 历史、双栏原始输出对照、本地存储管理。
- 单个 ACTIVE Experiment；实验内持久 FIFO 调度，默认并发 `min(4, N)`。
- 文本、最多 10 张原始图片、最多 5 GiB / 200,000 文件的完整 Baseline 快照。
- `Stop`、`Stop All`、`Retry`、`Run Again`、原子 `Retry Failed`。
- Host 崩溃后的 STARTING、执行未知窗口、FINALIZING 和 Seal 收敛。
- 插件专属 SQLite（`BEGIN IMMEDIATE`、`synchronous=FULL`、CAS、partial unique indexes）。
- Rust `openat/fstatat/O_NOFOLLOW` 文件边界、内容寻址快照、fencing token、`F_PREALLOCATE` 双缓冲控制 slot。
- macOS deny-default Seatbelt、private HOME/TMPDIR、无网络、进程组 10 秒取消。
- 自包含归档、不可变 Seal、Finder 打开和 Durable Delete receipt。

V1 不包含评分、排名、Judge、Elo、批量 Benchmark 或外部 Agent CLI。

## 固定版本

- DSH: `0.1.0-rc.7`
- DSH source commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Node: `^22.19 || >=24`
- macOS: arm64 / x64 原生可选包

版本、Adapter、图片 wire path、session 新鲜度、隔离、归档和控制容量均由启动时 Compatibility Gate 动态证明；阻断项会保留 UI 查询能力并关闭 Start。

pi-ai 内置模型的 wire protocol、上下文与输出 token 能力来自锁定的 `@earendil-works/pi-ai@0.82.1` catalog；自定义 route 从脱敏 profile 解析。Preflight 诊断会展示这些能力、Serializer 依赖与最终 fingerprint，公共输出能力低于 8192 时直接阻断。

## 开发与验证

```bash
corepack enable
pnpm install
pnpm build:native
pnpm check
```

当前架构的完整自动化检查包含 TypeScript strict typecheck、领域/SQLite/RPC/UI 测试、Rust helper 真实文件系统测试和 macOS Seatbelt hostile-orphan 测试。

## 安装到 DSH Web Profile

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

目录为 `0700`、文件为 `0600`。Experiment 永久保留，只能在 SETTLED 且没有进行中 Action 时手动删除。

## 关键实现入口

- Host 生命周期：`src/host/runtime.ts`
- RPC 边界：`src/host/rpc-router.ts`
- 调度与恢复：`src/host/scheduler.ts`
- SQLite 控制面：`src/storage/store.ts`
- 固定 Harness：`src/host/harness.ts`
- 原生 helper：`native/model-pk-helper/src/main.rs`
- 正式 UI：`src/client/App.tsx`
- 兼容与发布证据：`docs/COMPATIBILITY_REPORT.md`
