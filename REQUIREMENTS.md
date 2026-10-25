# zen-fs-config-admin 需求文档：支持数据同步组

> 本文件是 `../todo.md`「项目 1」的**需求**部分。
> 设计见 [`DESIGN.md` §11](./DESIGN.md)（数据同步组专章），
> 集成测试见 [`docs/integration-test.md`](./docs/integration-test.md)。

## 1. 背景

`zen-fs-config` 把同步分成两类组：

- **配置同步组（config-sync）**：同步 `.meta/` 下的配置与拓扑，admin 当前已支持，
  通过 `createConfigRepo(APP_ID)` 自动连接并同步。
- **数据同步组（data-sync / app data group）**：应用自己的数据文件，
  描述符位于 `.meta/app-data-groups/{appId}/{id}.json`，由 `zen-fs-config` 的
  `listAppDataGroups()` / `getAppDataGroup()` / `createAppDataGroup()` /
  `removeAppDataGroup()` 管理。

**现状问题**：数据组只有被 `getAppDataGroup(id)` 实例化时才会启动同步
（`AppDataGroupImpl.init()` 会建本地主副本 → 为每个后端建双向 `SyncPair` →
`syncAll()` → `watchAll()`）。admin 从不调用这些方法，因此
`appId='admin'` 下已经配置好的数据组**一个都不会被同步**。

## 2. 目标

| 编号 | 目标 |
|------|------|
| G1 | admin 连上配置仓后，自动激活并同步 `appId='admin'` 下的**所有**数据同步组 |
| G2 | 文件浏览器在现有树根下新增 **“Data Groups”** 节点，展开可见各组目录树，可查看/编辑 |
| G3 | admin 提供数据组 CRUD UI：创建 / 删除数据组，增删组内后端 |
| G4 | reconnect / dispose 时数据组随之重建 / 释放，无泄漏或重复 SyncPair |
| G5 | 有单元测试 + 集成测试覆盖 |

## 3. 范围

### 3.1 范围内

- `src/context/ConfigRepoContext.tsx`：枚举 + 激活数据组，暴露句柄与同步状态。
- `src/pages/FilesPage.tsx`：树根并入 “Data Groups” 虚拟节点。
- `src/pages/DataGroupsPage.tsx`（新增）：数据组 CRUD UI。
- `src/App.tsx` / `src/components/Layout.tsx`：新增路由与导航项。
- 单元测试与集成测试文档。

### 3.2 范围外

- admin 自身作为数据组副本参与同步（不需要）。
- `zen-fs-config` 侧数据组能力的改动（能力已具备，仅 admin 未使用）。
- 冲突处理 UI（复用现有冲突策略 `source-wins`）。

## 4. 功能性需求

### FR1 — 自动激活数据组

| 编号 | 需求 | 验收 |
|------|------|------|
| FR1.1 | `createRepo()` 成功后，调用 `repo.listAppDataGroups()` 枚举全部数据组 | 单元测试 |
| FR1.2 | 对每个组调用 `repo.getAppDataGroup(id)` 激活（触发初始同步 + watch） | 单元测试 |
| FR1.3 | 单个组激活失败（后端不可达等）时**记录错误并继续**，不影响其它组与整体连接 | 单元测试 |
| FR1.4 | 只处理 `appId = 'admin'` 的数据组（与配置仓一致） | 代码审查 |
| FR1.5 | 上下文暴露 `dataGroups`（id + 组句柄 + 后端数 + 同步状态）与 `getDataGroupFs(id)` | 单元测试 |
| FR1.6 | 提供 `refreshDataGroups()`，供 CRUD 操作后刷新 | 单元测试 |
| FR1.7 | `reconnect()` 时先释放旧 repo 的数据组，再在新 repo 上重新激活 | 单元测试 |
| FR1.8 | 组件卸载 / repo 替换时释放数据组，避免重复 SyncPair 与泄漏 | 单元测试 |

### FR2 — 文件浏览器 “Data Groups” 节点

| 编号 | 需求 | 验收 |
|------|------|------|
| FR2.1 | 树根新增虚拟目录节点 **Data Groups**（与配置仓的真实根节点并列） | 集成测试 |
| FR2.2 | 展开 Data Groups 列出各数据组（组 id 作为子目录） | 集成测试 |
| FR2.3 | 展开某组后，用该组的 `group.fs.promises` 加载目录树（懒加载） | 集成测试 |
| FR2.4 | 组内文件可查看 / 编辑，复用现有编辑器 | 集成测试 |
| FR2.5 | 组内路径**跳过**配置仓的 `.version` sidecar 版本信息查询（数据组无该体系） | 代码审查 |
| FR2.6 | 配置仓分支行为保持不变（仍用 `repo.rootFS.promises`） | 集成测试 |
| FR2.7 | 路径需要能区分「配置仓路径」与「数据组路径」，避免歧义 | 代码审查 |

### FR3 — 数据组管理 UI（CRUD）

| 编号 | 需求 | 验收 |
|------|------|------|
| FR3.1 | 列表：展示 id、后端数、各后端类型、同步状态 | 集成测试 |
| FR3.2 | 创建：表单收集 id + 若干后端（`type` + `options`），调用 `repo.createAppDataGroup(id, backends)` | 集成测试 |
| FR3.3 | 后端类型与表单元数据复用 `register-backends.ts` / `backend-types.ts` 已注册的类型 | 代码审查 |
| FR3.4 | 删除：调用 `repo.removeAppDataGroup(id)`，并释放对应实例 | 集成测试 |
| FR3.5 | 组内增删后端：调用组的 `addBackend` / `removeBackend`，操作后刷新同步对与文件树 | 集成测试 |
| FR3.6 | 后端表单支持「复用已有配置同步后端的账号字段」（`accountBackendId`） | 可选，代码审查 |
| FR3.7 | 所有写操作后刷新数据组列表与文件树 | 集成测试 |

## 5. 非功能性需求

| 编号 | 需求 |
|------|------|
| NFR1 | 不得阻塞首屏：数据组激活在连接完成后异步进行，期间 UI 可用 |
| NFR2 | 单个数据组失败不影响其它数据组与配置仓（错误隔离） |
| NFR3 | 不重复创建 SyncPair（同一 group id 只实例化一次，复用 `repo` 内部缓存） |
| NFR4 | 所有新增代码通过 `npm run lint` 与 `tsc -b` |
| NFR5 | 单元测试不依赖浏览器 IndexedDB（用可注入的假 repo） |

## 6. 约束与假设

- **A1**：数据组接口以 `zen-fs-config` 的 `AppDataGroup` 为准
  （`groupId` / `appId` / `fs` / `getSyncStatuses()` / `flush()` / `dispose()` /
  `addBackend()` / `removeBackend()` / `listBackends()`）。
- **A2**：数据组的 `fs` 是一个 chroot 到本组根的文件系统（Node 风格 `fs`），
  其 `promises` API 与 `repo.rootFS.promises` 形状一致，
  因此 `loadChildren(fs, dir)` 可复用。
- **A3**：数据组没有 `.version` sidecar 版本体系，文件页的版本信息区块需跳过。
- **A4**：admin 的 `APP_ID = 'admin'` 固定，与配置仓一致。

## 7. 验收标准（对应 todo.md）

- [ ] admin 连上配置仓后，自动激活并同步 `appId='admin'` 下的所有数据同步组
      （初始同步 + watch，与配置仓一致）。
- [ ] 文件浏览器根下出现 “Data Groups” 节点，展开可见各数据组目录树，可查看/编辑。
- [ ] reconnect / dispose 时数据组随之正确重建 / 释放，无泄漏或重复 SyncPair。
- [ ] 有单元测试 + 集成测试覆盖。
- [ ] 数据组 CRUD（创建/删除组、增删后端）可用（Q1 确认需要）。
