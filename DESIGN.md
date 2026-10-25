# zen-fs-config-admin — Design Document

## 1. Overview

Web 管理后台，用于可视化管理 zen-fs-config 配置仓库。在浏览器中直接连接 ZenFS 后端（InMemory / IndexedDB / S3 / HTTP），提供文件浏览、配置编辑、后端拓扑管理、同步状态监控和冲突解决功能。

**技术栈**：React + TypeScript + Vite + react-router-dom + zen-fs-config

**GitHub**: https://github.com/weijia/zen-fs-config-admin

## 2. Requirements

### 2.1 Functional Requirements

| ID | Requirement | Priority |
|----|------------|----------|
| F01 | 连接配置仓库（选择后端类型、填写连接参数、选择 appId） | P0 |
| F02 | 浏览文件树（/{appId}/、/shared/、/nodes/、/.meta/） | P0 |
| F03 | 查看和编辑 JSON 配置文件（带格式化和校验） | P0 |
| F04 | 保存配置（自动走 zen-fs-config 的序列化 + 版本号） | P0 |
| F05 | 查看和管理后端拓扑（增删改 .meta/backends.json） | P0 |
| F06 | 查看和编辑同步规则（.meta/sync-rules.json） | P1 |
| F07 | 查看同步状态（各 sync pair 的状态、最近同步结果） | P1 |
| F08 | 手动触发 flush（全量同步） | P1 |
| F09 | 查看冲突列表、对比双方内容、手动合并 | P1 |
| F10 | 浏览节点本地配置（/nodes/ 下的只读浏览） | P2 |
| F11 | 发布节点配置（调用 publishNodeConfig） | P2 |
| F12 | 查看版本历史（sidecar .version 文件内容） | P2 |
| F13 | 多 appId 切换（连接时指定，运行时可切换） | P2 |

### 2.2 Non-Functional Requirements

| ID | Requirement |
|----|------------|
| N01 | 纯浏览器端运行，不需要自建后端服务 |
| N02 | 通过 InMemory 后端可直接使用，无需外部依赖 |
| N03 | IndexedDB 后端支持离线访问已缓存的配置 |
| N04 | 远程后端（S3/HTTP）通过代理或 CORS 连接 |
| N05 | 单页应用，页面切换无刷新 |
| N06 | 响应式布局，支持桌面端（1024px+） |

## 3. Architecture

### 3.1 Three-Layer Architecture

```
React UI (Components + Pages)
    ↓ hooks
useConfigRepo (React context + hook)
    ↓
zen-fs-config (IConfigRepo)
    ├─ zen-fs-cache  → CachedFileSystem
    ├─ @zenfs/core   → ZenFS backends
    └─ zen-fs-sync   → Sync engine
```

UI 层不直接操作 zen-fs-config 的 API，而是通过 `useConfigRepo` hook 访问。

### 3.2 Connection Flow

```
用户在 Connect 页面填写:
  - appId (如 "my-app")
  - 后端类型 (InMemory / IndexedDB / 自定义)
  - 后端参数

→ createConfigRepo(appId, options)
→ ConfigRepo 实例存入 React Context
→ 路由跳转到 Dashboard
```

### 3.3 Data Flow

```
UI Event → hook 调用 → IConfigRepo API → zen-fs-config 内部处理
                                                    ↓
UI 状态更新 ← hook 返回 ← result / error  ← zen-fs-sync / cache / backend
```

## 4. Page Design

### 4.1 Page List

| Route | Page | Description |
|-------|------|-------------|
| `/` | Redirect to `/connect` or `/dashboard` |
| `/connect` | ConnectPage | 连接配置仓库 |
| `/dashboard` | DashboardPage | 同步状态总览 |
| `/files` | FilesPage | 文件浏览与编辑（默认入口） |
| `/files/:path*` | FilesPage | 嵌套路径路由 |
| `/backends` | BackendsPage | 后端拓扑管理 |
| `/sync-rules` | SyncRulesPage | 同步规则编辑 |
| `/conflicts` | ConflictsPage | 冲突列表与解决 |
| `/nodes` | NodesPage | 节点配置浏览 |

### 4.2 Layout

```
┌──────────────────────────────────────────────────────┐
│  zen-fs-config-admin        [appId] [Disconnect]      │
├──────────┬───────────────────────────────────────────┤
│ Sidebar  │  Content Area                             │
│          │                                           │
│ Dashboard│  (Router Outlet)                          │
│ Files    │                                           │
│ Backends │                                           │
│ Rules    │                                           │
│ Conflicts│                                           │
│ Nodes    │                                           │
│          │                                           │
├──────────┴───────────────────────────────────────────┤
│  Status bar: sync status, last sync time, node ID    │
└──────────────────────────────────────────────────────┘
```

- Sidebar 宽度 200px，可折叠
- 顶部导航栏显示 appId 和断开连接按钮
- 底部状态栏显示同步状态

### 4.3 Connect Page

表单字段：
- **App ID**（必填，文本输入）
- **Backend Type**（下拉选择：InMemory / IndexedDB）
- **Backend Options**（JSON 编辑器，根据类型动态展示默认值）
- **Cache TTL**（数字输入，单位 ms，默认 60000）
- **Connect 按钮**

连接逻辑：
```typescript
const repo = await createConfigRepo(appId, {
  primaryBackendId: 'admin-primary',
  backendInfo: { type, options: parsedOptions },
  cache: { storeType, ttlMs },
});
// 存入 Context
setConfigRepo(repo);
navigate('/dashboard');
```

### 4.4 Dashboard Page

卡片式布局：

| Card | 内容 |
|------|------|
| **Sync Pairs** | 数量、watching/idle 数量、总同步次数 |
| **Recent Sync** | 最近一次同步结果（文件增删改数、耗时） |
| **Conflicts** | 未解决冲突数量，点击跳转 |
| **Backends** | 后端数量列表，主后端高亮 |
| **Node Info** | 当前 nodeId、连接的后端类型 |

### 4.5 Files Page

左右分栏布局：

```
┌─────────────────┬──────────────────────────────────┐
│ File Tree       │  Editor / Viewer                  │
│                 │                                   │
│ ▼ /app-id/      │  {                                │
│   database.json │    "host": "localhost",           │
│   cache.json    │    "port": 5432                   │
│ ▼ /shared/      │  }                                │
│   flags.json    │                                   │
│ ▼ /nodes/       │  [Save] [Format] [Version Info]   │
│ ▼ /.meta/       │                                   │
└─────────────────┴──────────────────────────────────┘
```

- 左侧：递归目录树，点击展开/折叠，点击文件加载到编辑器
- 右侧：
  - JSON 文件 → JSON 编辑器（textarea + 格式化）
  - .version 文件 → 只读展示（版本号、hash、author、时间）
  - 其他文件 → 纯文本查看
- 底部工具栏：Save（调用 setConfig）、Format JSON、查看版本信息
- 路径变更时 URL 同步更新

### 4.6 Backends Page

表格 + 表单：

**后端列表表格**：

| ID | Type | Description | Primary? | Actions |
|----|------|-------------|----------|---------|
| local-idb | InMemory | 主缓存 | ★ | [Edit] [Remove] |

**添加/编辑表单**（Modal 或内联）：
- ID（必填）
- Type（下拉 + 自定义输入）
- Options（JSON 编辑器）
- Description（可选）

保存时直接修改 `.meta/backends.json` 并重新触发同步。

### 4.7 Sync Rules Page

规则列表表格 + 添加/编辑：

| Prefix | Direction | Strategy | Replicas | Actions |
|--------|-----------|----------|----------|---------|
| /my-app/ | one-way | source-wins | local-idb, s3 | [Edit] [Delete] |
| /shared/ | bi-directional | merge | local-idb, s3 | [Edit] [Delete] |
| /nodes/ | none | - | - | [Edit] [Delete] |

编辑时提供：
- Prefix 路径输入
- Direction 下拉（one-way / bi-directional / none）
- Conflict Strategy 下拉（source-wins / target-wins / merge）
- Replicas 多选（从已注册后端中选择）

### 4.8 Conflicts Page

冲突列表 + 详情对比：

**列表**：

| Time | Path | Source Author | Target Author | Strategy | Actions |
|------|------|--------------|---------------|----------|---------|
| 2026-07-19 10:30 | /shared/flags.json | app-a/node-1 | app-b/node-2 | source-wins | [View] [Resolve] |

**详情对比视图**（点击 View）：

```
┌──────────────────┬──────────────────┐
│ Source (v3)      │ Target (v4)      │
│                  │                  │
│ { "dark": true } │ { "dark": false, │
│                  │   "lang": "en" } │
│                  │                  │
└──────────────────┴──────────────────┘
┌─────────────────────────────────────┐
│ Merged Result (editable)            │
│                                     │
│ { "dark": true, "lang": "en" }     │
│                                     │
│              [Save Resolution]      │
└─────────────────────────────────────┘
```

### 4.9 Nodes Page

节点配置浏览器：

- 列出 `/nodes/` 下的所有 nodeId 目录
- 点击进入查看该节点的配置文件
- [Publish] 按钮调用 `publishNodeConfig`
- [Peek] 标签页可查看其他节点已发布的配置

## 5. Component Design

### 5.1 Component Tree

```
App
├── ConfigRepoProvider (Context)
│   ├── TopBar
│   │   ├── Logo
│   │   ├── AppIdBadge
│   │   └── DisconnectButton
│   ├── Sidebar
│   │   └── NavItem × N
│   ├── MainContent (Router Outlet)
│   │   ├── ConnectPage
│   │   ├── DashboardPage
│   │   │   └── StatCard × N
│   │   ├── FilesPage
│   │   │   ├── FileTree
│   │   │   ├── FileEditor
│   │   │   └── VersionInfo
│   │   ├── BackendsPage
│   │   │   ├── BackendTable
│   │   │   └── BackendForm (Modal)
│   │   ├── SyncRulesPage
│   │   │   ├── RulesTable
│   │   │   └── RuleForm (Modal)
│   │   ├── ConflictsPage
│   │   │   ├── ConflictTable
│   │   │   └── ConflictDetail (DiffView)
│   │   └── NodesPage
│   │       ├── NodeList
│   │       └── NodeConfigView
│   └── StatusBar
└── (未连接时)
    └── ConnectPage (全屏)
```

### 5.2 Key Hooks

| Hook | Description |
|------|-------------|
| `useConfigRepo()` | 从 Context 获取 IConfigRepo 实例 |
| `useFileTree()` | 递归读取目录，构建树形结构 |
| `useFileContent(path)` | 读取文件内容，支持 JSON parse |
| `useSyncStatuses()` | 定时轮询同步状态 |
| `useConflicts()` | 读取冲突列表 |
| `useBackends()` | 读取 .meta/backends.json |

### 5.3 Context Design

```typescript
interface ConfigRepoContextValue {
  repo: IConfigRepo | null;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  connect: (appId: string, options: ConfigRepoOptions) => Promise<void>;
  disconnect: () => Promise<void>;
}
```

## 6. State Management

不引入额外状态管理库。使用 React Context + useReducer 管理全局状态，各页面用 useState/useEffect 管理局部状态。

全局状态：
- `repo`: IConfigRepo 实例
- `connected`: boolean
- `connecting`: boolean
- `error`: string | null

页面局部状态通过 hooks 封装，不污染全局。

## 7. Styling

- 纯 CSS，不引入 UI 框架
- CSS Variables 定义主题色
- 暗色主题为主（开发者工具风格）
- 布局使用 CSS Grid + Flexbox

### 7.1 Color Tokens

```css
:root {
  --bg-primary: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  --border: #30363d;
  --text-primary: #e6edf3;
  --text-secondary: #8b949e;
  --accent: #58a6ff;
  --accent-hover: #79c0ff;
  --success: #3fb950;
  --warning: #d29922;
  --danger: #f85149;
  --sidebar-width: 200px;
}
```

## 8. Error Handling

| 场景 | 处理方式 |
|------|---------|
| 连接失败 | Connect 页面显示错误消息，不跳转 |
| 文件读取失败 | Editor 区域显示错误，提供重试按钮 |
| 保存失败 | Toast 提示错误，不丢失编辑内容 |
| 同步失败 | Dashboard 显示错误状态，Conflicts 页面记录 |
| 后端操作失败 | Modal 内显示错误，不关闭 |

## 9. Security Considerations

- 本工具为管理后台，应部署在受控环境
- InMemory 后端数据不持久化，刷新丢失
- 远程后端连接信息存储在浏览器内存中，不持久化到 localStorage
- 如需持久化连接信息，由使用者自行决定

## 10. Future Enhancements

- F01: 支持更多后端类型（S3、Google Drive、WebDAV）
- F02: 配置变更历史（基于 .version 文件的 diff 查看）
- F03: 批量操作（多选文件删除/移动）
- F04: 配置搜索（全文搜索所有配置项）
- F05: 导入/导出（从本地文件导入配置到仓库）
- F06: 多语言支持（i18n）
## 11. Data Sync Groups（数据同步组）

> 需求见 [`REQUIREMENTS.md`](./REQUIREMENTS.md)，集成测试见
> [`docs/integration-test.md`](./docs/integration-test.md)。

### 11.1 为什么需要

`zen-fs-config` 的数据同步组（`AppDataGroup`）只有被 `getAppDataGroup(id)`
实例化时才会启动同步：`init()` 会建本地主副本 → 为每个后端建双向 `SyncPair`
→ `syncAll()` → `watchAll()`。admin 此前从不调用这些方法，因此
`appId='admin'` 下已配置的数据组完全不会被同步。

### 11.2 Context 改动（`src/context/ConfigRepoContext.tsx`）

```
createRepo()
   └─ createConfigRepo('admin')          ← 配置仓（既有）
        └─ activateDataGroups(repo)      ← 新增
             ├─ repo.listAppDataGroups()
             └─ for each: repo.getAppDataGroup(id)   → 触发 init()（同步 + watch）
```

- `activateDataGroups(repo)` 是**纯函数**，便于单测注入假 repo。
- `repo` 内部按 id 缓存实例，重复调用不会产生重复 `SyncPair`。
- 单个组失败只记录 `error` 字段并继续，不阻断其它组与整体连接（错误隔离）。
- 上下文新增：`dataGroups` / `dataGroupsLoading` / `dataGroupsError` /
  `getDataGroupFs(id)` / `refreshDataGroups()`。
- `reconnect()`：先 `disposeDataGroups(old)` + `oldRepo.dispose()`，
  再在新 repo 上重新激活。
- 组件卸载：`disposeDataGroups()` + `repo.dispose()`，避免泄漏。

### 11.3 文件浏览器作用域（`src/pages/FilesPage.tsx`）

树根同时承载两类内容，用保留前缀 `/@dg` 区分，从而复用现有 `/files/*` 路由
与选中态：

| 作用域 | 树路径 | 实际 fs | 组内路径 |
|--------|--------|---------|----------|
| 配置仓 | `/admin/foo.json` | `repo.rootFS.promises` | 同左 |
| Data Groups 容器 | `/@dg` | — | — |
| 某数据组 | `/@dg/<groupId>/x/y.json` | `getDataGroupFs(groupId)` | `/x/y.json` |

- `resolveFs(path)` 按树路径解析 fs；`FileTree` / `TreeNodeView` 由原来接收
  单个 `fs` 改为接收 `resolveFs`，`loadChildren(fs, dir)` 完全复用。
- 虚拟节点 `kind: 'data-groups' | 'data-group'`，图标用 🗂️ 区分。
- 数据组作用域**跳过** `.version` sidecar 查询（数据组无该体系）。
- 保存：配置仓走 `repo.setConfig()` / `fs.writeFile()`；数据组只走
  `fs.writeFile()`。

### 11.4 管理页面（`src/pages/DataGroupsPage.tsx`）

| 操作 | API |
|------|-----|
| 列表 | context `dataGroups` |
| 创建组 | `repo.createAppDataGroup(id, backends)` |
| 删除组 | `repo.removeAppDataGroup(id)` |
| 组内加后端 | `group.addBackend(id, type, options, description)` |
| 组内删后端 | `group.removeBackend(id)` |
| 立即同步 | `group.flush()` |

- 后端类型与表单元数据复用 `backend-types.ts`（`getBackendTypeDef` /
  `getBackendTypes`），与 Backends 页一致。
- 支持「复用配置同步后端的账号字段」（`accountBackendId`，下拉来自
  `repo.listAccountBackends()`）。
- 每次写操作后调用 `refreshDataGroups()` 刷新列表与文件树。

### 11.5 状态与错误

- 数据组激活是**异步且不阻塞首屏**的：连接建立后 `connected` 立即为 true，
  数据组随后填充。
- 激活失败在 `dataGroupsError` 汇总展示，同时每个组的 `error` 单列展示。
