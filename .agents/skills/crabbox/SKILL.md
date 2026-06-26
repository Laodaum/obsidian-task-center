---
name: crabbox
description: Run CI checks (typecheck, lint, unit tests, e2e) via this repo's BYOI external/k3s Crabbox backend. Use when you need to run the formal remote gate on the private Linux CI host.
---

# Crabbox

本仓库默认走 Bring Your Own Infrastructure / external lifecycle 后端：

- provider: `external`、target: `linux`、box 生命周期（`external.command` / `idempotentLeaseId` / `workRoot`）都声明在 `.crabbox.yaml` 里，所以 `crabbox run` 不再带任何 per-run lifecycle flag。
- 真实 host、k3s namespace、镜像等真正内网的值不写入 git：由 gitignored 的 `.crabbox/external-lease-provider.mjs`（adapter）从 `.crabbox/remote-test.env` 的环境变量读取。

Crabbox 在这个模式下不创建、不销毁宿主机；宿主机生命周期由操作者负责。正式 gate 通过本地私有 external adapter 控制私有 k3s/containerd 宿主：每个 run 创建一个带 SSH 的 Pod lease，Crabbox 同步 checkout、远端执行命令、回传日志和结果，结束后释放对应 Pod。每个 run 拿到唯一 lease id → 唯一 Pod，多个 agent 并行各自独立隔离。

## 正式 gate

```bash
pnpm run test:remote
```

`pnpm run test:remote` 从 `.crabbox/remote-test.env` 读取：

- `CRABBOX_TEST_PREPARE`：可选，建立跳板或端口转发等前置连接。
- `CRABBOX_TEST_GATE`：必选，`crabbox run --shell '...'` 形态。provider / target / external lifecycle 全部来自 `.crabbox.yaml`，gate 里不再重复这些 flag。

正式 gate 至少包含：

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run build
CI=true GITHUB_ACTIONS=true OBSIDIAN_VERSIONS=latest/latest WDIO_MAX_INSTANCES=1 pnpm run test:e2e:ci
```

## 单项检查

如果只需要远端跑一个窄检查，lifecycle 已在 `.crabbox.yaml`，直接：

```bash
crabbox run -- pnpm run typecheck
crabbox run -- pnpm run lint
crabbox run -- pnpm run test:unit
```

前提是本机 `.crabbox/remote-test.env` 和 `.crabbox/external-lease-provider.mjs`（adapter）已经存在。

## 说明

- Crabbox 配置: `.crabbox.yaml`
- 私有远端 gate 配置: `.crabbox/remote-test.env`（gitignore）
- 本仓库的正式远端开发验证入口: `pnpm run test:remote`
- GitHub PR / release gate 仍然看 `.github/workflows/ci.yml` 和 `release.yml`
