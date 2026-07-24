# zen-fs-config 完整 API 参考

本文档面向使用 `zen-fs-config` 的开发者，详细解释每个参数和 API 的含义。

## 目录

- [创建配置仓库 `createConfigRepo`](#创建配置仓库-createconfigrepo)
- [后端注册 `registerBackend`](#后端注册-registerbackend)
- [IConfigRepo 核心 API](#iconfigrepo-核心-api)
- [同步机制](#同步机制)
- [冲突处理](#冲突处理)
- [目录结构](#目录结构)
- [完整示例](#完整示例)

---

## 创建配置仓库 `createConfigRepo`

```typescript
function createConfigRepo(
  appId: string,
  options: ConfigRepoOptions
): Promise<IConfigRepo>
```

### `appId` — 应用标识符

**类型**: `string`

**必填**: 是

**作用**: 标识当前应用。配置文件在虚拟文件系统中的根目录为 `/{appId}/`。

**示例**: `'admin'`, `'my-service'`, `'app-v2'`

> 不同 `appId` 的应用互相隔离，不能读取对方的配置。共享数据需放在 `/shared/` 下。

---

### `ConfigRepoOptions` — 创建选项

```typescript
interface ConfigRepoOptions {
  /** 主后端在 backends.json 中的 ID */
  primaryBackendId: string;

  /** 主后端的连接信息 */
  backendInfo: {
    type: string;
    options: Record<string, unknown>;
  };

  /** 节点 ID（不传则自动生成） */
  nodeId?: string;

  /** 缓存配置 */
  cache?: CacheOptions;

  /** 自定义序列化器 */
  serializer?: ConfigSerializer;

  /** 冲突处理回调 */
  onConflict?: (conflict: ConflictInfo) => Promise<unknown | null>;
}
```

#### `primaryBackendId`

**类型**: `string`  
**必填**: 是

当前实例使用哪个后端作为主后端。这个 ID 会被写入 `/.meta/backends.json`。

**示例**: `'admin-primary'`, `'local-memory'`, `'github-main'`

#### `backendInfo.type`

**类型**: `string`  
**必填**: 是

主后端的类型名。**必须在调用 `createConfigRepo` 之前通过 `registerBackend()` 注册过**。

可用类型取决于你注册了哪些后端：

| 类型 | 说明 | 需要注册 |
|---|---|---|
| `InMemory` | 内存文件系统，数据不持久 | 内置（无需注册） |
| `IndexedDB` | 浏览器 IndexedDB 持久化 | `zen-fs-config-admin` 已注册 |
| `WebStorage` | localStorage / sessionStorage | `zen-fs-config-admin` 已注册 |
| `GitHub` | GitHub 仓库作为文件系统 | `zen-fs-config-admin` 已注册 |
| `Gitee` | Gitee 仓库作为文件系统 | `zen-fs-config-admin` 已注册 |
| `WebDAV` | WebDAV 服务器 | `zen-fs-config-admin` 已注册 |
| `RemoteStorage` | RemoteStorage 协议 | `zen-fs-config-admin` 已注册 |

#### `backendInfo.options`

**类型**: `Record<string, unknown>`  
**必填**: 是

传给后端工厂函数的参数。**每个后端需要的字段不同**。

如何知道某个后端需要什么参数？查询它的 metadata：

```typescript
import { getBackendMetadata } from 'zen-fs-config';

const meta = getBackendMetadata('Gitee');
// meta = {
//   type: 'Gitee',
//   label: 'Gitee',
//   icon: '🦊',
//   fields: [
//     { key: 'owner', label: 'Owner', type: 'text', required: true, placeholder: 'weijia' },
//     { key: 'repo',  label: 'Repo',  type: 'text', required: true, placeholder: 'my-configs' },
//     { key: 'branch', label: 'Branch', type: 'text', placeholder: 'master' },
//     { key: 'token', label: 'Token', type: 'password', placeholder: 'gitee token' },
//     { key: 'baseUrl', label: 'API URL', type: 'text', placeholder: 'https://gitee.com/api/v5' },
//   ],
//   defaultOptions: { owner: '', repo: '', branch: 'master', token: '', baseUrl: '' },
// }
```

所以创建 Gitee 后端的配置是：

```typescript
const repo = await createConfigRepo('admin', {
  primaryBackendId: 'my-gitee',
  backendInfo: {
    type: 'Gitee',
    options: {
      owner: 'weijia',
      repo: 'my-configs',
      branch: 'master',
      token: 'xxx',
      // baseUrl 是可选的，不传则使用默认
    },
  },
});
```

#### `nodeId`

**类型**: `string`  
**必填**: 否（默认自动生成）

标识当前运行实例。用于：
- 节点本地配置隔离（`/{appId}/nodes/{nodeId}/`）
- 版本文件中的 `author` 字段
- 冲突归档中的源/目标标识

**自动生成规则**（不传时）：
1. 优先读取 `process.env.NODE_ID`
2. 其次读取主后端上 `/.meta/.node-id` 文件
3. 最后生成随机 ID：`node-${timestamp}-${random}`

**示例**: `'server-1'`, `'client-a'`, `'edge-node-tokyo'`

#### `cache`

**类型**: `CacheOptions`  
**必填**: 否  
**默认**: `undefined`（**无缓存层**，所有读写直接穿透到后端）

```typescript
interface CacheOptions {
  storeType?: 'MemoryCacheStore' | 'IdbCacheStore';
  storePrefix?: string;     // IdbCacheStore 用的 key 前缀
  ttlMs?: number;           // 缓存 TTL（毫秒），默认 0（总是重新验证）
}
```

**作用**: 在主后端之上加一层 `zen-fs-cache` 缓存，减少网络请求。

> **注意**: 如果不传 `cache`，`createConfigRepo` 直接使用原始后端实例，没有任何缓存中间层。`setConfig` 的内存缓存（`configCache`）始终存在，但它只缓存配置值的 JS 对象，不缓存文件系统的 I/O。如果你希望减少后端的 `readdir` / `readFile` / `stat` 调用，必须显式传入 `cache`。

- `MemoryCacheStore` — 内存缓存，页面刷新即丢失
- `IdbCacheStore` — 基于 IndexedDB，跨会话持久
- `ttlMs` — 缓存有效期。`0` 表示每次读写都穿透到后端做条件验证（304），但缓存命中时仍可避免重复读取。

**示例**:

```typescript
cache: { storeType: 'MemoryCacheStore', ttlMs: 60_000 }
// → 内存缓存 60 秒，期间同一文件不重复向后端请求
```

#### `serializer`

**类型**: `ConfigSerializer`  
**必填**: 否

自定义序列化器。默认的序列化器已经支持：
- `.json` → JSON 序列化/反序列化
- `.txt` → UTF-8 文本
- 未知扩展名 → JSON 回退

如果你需要处理其他格式（如 `.yaml`、`.toml`），可以提供自定义序列化器：

```typescript
import YAML from 'yaml';

const yamlSerializer: ConfigSerializer = {
  serialize(data: unknown) {
    return new TextEncoder().encode(YAML.stringify(data));
  },
  deserialize(raw: Uint8Array, path: string) {
    return YAML.parse(new TextDecoder().decode(raw));
  },
  canHandle(path: string) {
    return path.endsWith('.yaml') || path.endsWith('.yml');
  },
};

const repo = await createConfigRepo('my-app', {
  primaryBackendId: 'local',
  backendInfo: { type: 'IndexedDB', options: {} },
  serializer: yamlSerializer,
});
```

#### `onConflict`

**类型**: `(conflict: ConflictInfo) => Promise<unknown | null>`  
**必填**: 否

自定义冲突处理器。当同步引擎检测到冲突时（双向同步中两侧都修改了同一文件），先调用此回调，你可以：

- 返回合并后的内容 → 引擎用你的结果覆盖两侧
- 返回 `null` → 引擎按内置策略自动解决（默认 `source-wins`）

```typescript
onConflict: async (conflict) => {
  console.log('冲突:', conflict.path);
  console.log('源:', conflict.sourceContent);
  console.log('目标:', conflict.targetContent);

  // 手动合并示例：取 source 的内容，但保留 target 的某个字段
  if (typeof conflict.sourceContent === 'object' &&
      typeof conflict.targetContent === 'object') {
    return { ...conflict.targetContent, ...conflict.sourceContent };
  }

  // 不处理，让引擎自动解决
  return null;
}
```

---

## 后端注册 `registerBackend`

在调用 `createConfigRepo` 之前，需要先注册你要使用的后端类型。

```typescript
function registerBackend(
  type: string,
  factory: BackendFactory,
  metadata?: BackendMetadata
): void
```

### 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `type` | `string` | 后端类型名，如 `'GitHub'`、`'WebDAV'` |
| `factory` | `BackendFactory` | 创建后端实例的异步工厂函数 |
| `metadata` | `BackendMetadata` | 后端的参数描述（用于 UI 自动生成表单） |

### `BackendFactory`

```typescript
type BackendFactory = (options: Record<string, unknown>) => Promise<BackendInstance>;
```

工厂函数接收用户传入的 `options`，返回一个满足 `BackendInstance` 接口的对象。这是你的后端与 `zen-fs-config` 之间的桥梁。

### `BackendInstance`

后端实例必须实现的接口：

```typescript
interface BackendInstance {
  readFile(path: string, ...args: any[]): Promise<any>;
  writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string, ...args: any[]): Promise<any>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: any): Promise<any>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename?(oldPath: string, newPath: string): Promise<void>;
  // 以下为可选
  readFileMeta?(path: string, opts?: any): Promise<any>;
  getRevision?(path: string): Promise<string | number | undefined>;
}
```

### `BackendMetadata` — 参数描述

```typescript
interface BackendMetadata {
  type: string;           // 类型名（与 registerBackend 第一个参数一致）
  label: string;          // 显示名称
  icon: string;           // 图标（emoji 或字符）
  fields: BackendParamDef[];  // 参数字段列表
  defaultOptions: Record<string, string>;  // 默认值
}

interface BackendParamDef {
  key: string;           // 字段名（对应 options 的 key）
  label: string;         // 显示标签
  type: 'text' | 'password' | 'select';  // 输入类型
  placeholder?: string;  // 占位提示
  required?: boolean;    // 是否必填
  options?: { value: string; label: string }[];  // select 类型的选项
}
```

### 注册示例

```typescript
import { registerBackend, wrapZenFSFileSystem } from 'zen-fs-config';

// 注册 Gitee 后端
registerBackend('Gitee', async (options) => {
  const { Gitee } = await import('zen-fs-gitee');
  return wrapZenFSFileSystem({
    backend: Gitee,
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    branch: options.branch,
    baseUrl: options.baseUrl || undefined,
  });
}, {
  type: 'Gitee',
  label: 'Gitee',
  icon: '🦊',
  fields: [
    { key: 'owner', label: 'Owner', type: 'text', placeholder: 'weijia', required: true },
    { key: 'repo',  label: 'Repo',  type: 'text', placeholder: 'my-configs', required: true },
    { key: 'branch', label: 'Branch', type: 'text', placeholder: 'master' },
    { key: 'token', label: 'Token', type: 'password', placeholder: 'gitee token' },
    { key: 'baseUrl', label: 'API URL', type: 'text', placeholder: 'https://gitee.com/api/v5' },
  ],
  defaultOptions: { owner: '', repo: '', branch: 'master', token: '', baseUrl: '' },
});
```

> `wrapZenFSFileSystem()` 是一个便捷函数，将任何 ZenFS `FileSystem` 实现包装成 `BackendInstance`。如果你的后端不基于 ZenFS，直接返回一个实现 `BackendInstance` 接口的对象即可。

---

## IConfigRepo 核心 API

创建完成后得到的 `repo` 对象：

### 配置读写

```typescript
// 写入配置（异步持久化 + 自动同步到 replicas）
repo.setConfig('/database', { host: 'localhost', port: 5432 });

// 读取配置（同步，从内存缓存读取）
const db = repo.getConfig<{ host: string; port: number }>('/database');

// 删除配置（写 tombstone，确保删除能传播到所有后端）
await repo.deleteFile('/database.json');
```

> `setConfig` 是同步的，因为它只写内存缓存，真正的持久化和同步是后台异步执行的。  
> 文件路径自动映射：`/database` → `/{appId}/database.json`

### 节点本地配置

```typescript
// 写入节点本地配置（不同步到其他后端）
await repo.setNodeConfig('node-1', '/debug', { level: 'verbose' });

// 读取节点本地配置
const debug = await repo.getNodeConfig('node-1', '/debug');

// 将节点配置一次性发布到所有 replica 后端
await repo.publishNodeConfig('node-1');

// 只读查看其他节点的已发布配置
const other = await repo.peekNodeConfig('node-2', '/debug');
```

### 手动同步

```typescript
// 手动触发所有 sync pair 的同步
const results = await repo.flush();
for (const r of results) {
  console.log(`${r.pairId}: +${r.filesCreated}/~${r.filesUpdated}/-${r.filesDeleted}`);
}

// 同步 .meta/ 文件（backends.json）到所有 replica
await repo.syncMetaToReplicas();
```

### 后端拓扑管理

```typescript
// 读取后端配置
const backends = await repo.getBackends();

// 更新后端配置（例如添加新 replica）
await repo.updateBackends({
  version: 1,
  backends: [
    ...backends.backends,
    { id: 'new-replica', type: 'WebDAV', options: { url: 'https://...' } },
  ],
});
```

### 冲突管理

```typescript
// 列出所有冲突归档
const conflicts = await repo.listConflicts();

// 读取冲突的原始备份
const source = await repo.readConflictBackup(conflictId, 'source');
const target = await repo.readConflictBackup(conflictId, 'target');

// 手动解决冲突
await repo.resolveConflict(conflictId, mergedContent);
```

### 底层文件系统访问

```typescript
// 标准 fs API，chroot 隔离到 /{appId}/ 和 /shared/
const data = await repo.fs.promises.readFile('/database.json', 'utf-8');

// 未隔离的 rootFS，可以访问 /.meta/ 等内部目录
const files = await repo.rootFS.promises.readdir('/.meta');
```

### 生命周期

```typescript
// 获取同步状态
const statuses = repo.getSyncStatuses();

// 释放资源、停止同步
await repo.dispose();
```

---

## 同步机制

### 同步对（Sync Pair）的建立

调用 `createConfigRepo` 时，内部会读取 `/.meta/backends.json`。对于其中**每个非 primary 且非 disabled** 的后端：

1. 用 `createBackend()` 创建后端实例
2. 用 `backendToSyncableFS()` 包装成 `SyncableFS`
3. 在 `syncEngine` 中注册一个双向同步 pair：
   - `source` = `fullFS`（主后端 + cache 层）
   - `target` = replica 后端
   - `direction` = `BiDirectional`
   - `conflictStrategy` = `source-wins`
   - `root` = `/`

### 同步触发时机

- **连接/重连时**: `syncOnceAndStop()` 会清空快照后做一次全量同步，然后停止监听
- **手动 flush 时**: `repo.flush()` 触发所有 pair 同步
- **手动 sync pair 时**: `engine.sync(pairId)` 同步指定 pair
- **后台监听**: `syncEngine.watch()` 会监听文件变化，但 admin 连接后会立即 `unwatch`，改为手动触发

### Tombstone 机制

当调用 `repo.deleteFile(path)` 时：
1. 在 `/.meta/.deleted/` 下写一个 tombstone 文件（记录删除时间、删除者）
2. 删除实际的配置文件
3. 同步前：`processTombstones()` 先删除所有 replica 上的对应文件（防止被重新复制回来）
4. 同步后：`updateTombstoneConfirmations()` 标记哪些 replica 已确认删除
5. GC：所有 replica 都确认的 tombstone 会被自动清理

---

## 冲突处理

### 冲突的产生

双向同步时，如果 source 和 target 的同一文件都发生了变化（mtime 不同），就会产生冲突。

### 自动解决

默认策略 `source-wins`：以主后端（source）的内容为准。冲突信息会被归档到 `/.meta/.conflicts/`。

### 冲突归档结构

```
/.meta/.conflicts/{timestamp}_{path}/
  ├── meta.json      # 冲突元信息（双方版本、作者、策略）
  ├── source         # source 侧的备份
  ├── target         # target 侧的备份
  └── resolved       # 解决后的内容（如果已手动解决）
```

### 手动解决

```typescript
const conflicts = await repo.listConflicts();
const c = conflicts[0];

// 读取双方内容
const source = await repo.readConflictBackup(c.conflictId, 'source');
const target = await repo.readConflictBackup(c.conflictId, 'target');

// 手动合并
const merged = merge(source, target);

// 提交解决
await repo.resolveConflict(c.conflictId, merged);
```

---

## 目录结构

虚拟文件系统（FS）中的完整目录布局：

```
/
├── {appId}/                    # 应用私有配置（自动同步到 replicas）
│   ├── config1.json
│   ├── config2.json
│   └── .config1.json.version   # sidecar 版本文件
│
├── shared/                     # 跨应用共享配置（自动同步）
│   └── flags.json
│
├── nodes/                      # 节点本地配置（默认不同步）
│   └── {nodeId}/
│       └── debug.json
│
└── .meta/                      # 元数据目录
    ├── backends.json           # 后端拓扑配置
    ├── .node-id               # 节点 ID 持久化文件
    ├── .conflicts/            # 冲突归档
    │   └── {timestamp}_{path}/
    │       ├── meta.json
    │       ├── source
    │       ├── target
    │       └── resolved
    └── .deleted/              # Tombstone 文件
        └── {filename}.json
```

### Sidecar `.version` 文件

每个配置文件都有一个对应的 `.version` 文件：

```json
// .db.json.version
{
  "version": 42,
  "hash": "sha256:abc123...",
  "author": "admin/node-abc",
  "timestamp": 1699123456789
}
```

- `version`: 单调递增的版本号
- `hash`: 文件内容的 SHA-256 哈希
- `author`: 最后修改者（`{appId}/{nodeId}`）
- `timestamp`: 修改时间戳

版本文件用于：
- 检测文件是否被修改（比对 hash）
- 冲突检测（两侧版本号不同时可能冲突）
- 追踪变更来源

---

## 完整示例

### 场景：浏览器应用，用 IndexedDB 作为主后端

```typescript
import { createConfigRepo, registerBackend, wrapZenFSFileSystem } from 'zen-fs-config';
import { IndexedDB } from '@zenfs/dom';

// 1. 注册后端（实际应用中通常在 app 启动时统一注册）
registerBackend('IndexedDB', async (options) => {
  return wrapZenFSFileSystem({
    backend: IndexedDB,
    storeName: options.storeName as string,
  });
}, {
  type: 'IndexedDB',
  label: 'IndexedDB',
  icon: '💾',
  fields: [
    { key: 'storeName', label: 'Store Name', type: 'text', placeholder: 'zen-fs-config-1' },
  ],
  defaultOptions: { storeName: 'zen-fs-config-1' },
});

// 2. 创建配置仓库
const repo = await createConfigRepo('my-app', {
  primaryBackendId: 'local-idb',
  backendInfo: {
    type: 'IndexedDB',
    options: { storeName: 'my-app-config' },
  },
  cache: {
    storeType: 'MemoryCacheStore',
    ttlMs: 60_000,   // 60 秒缓存
  },
  onConflict: async (conflict) => {
    console.warn('冲突:', conflict.path);
    // 返回 null 让引擎自动解决
    return null;
  },
});

// 3. 读写配置
repo.setConfig('/api/endpoints', {
  user: 'https://api.example.com/users',
  order: 'https://api.example.com/orders',
});

const endpoints = repo.getConfig('/api/endpoints');

// 4. 节点本地配置
await repo.setNodeConfig(repo.nodeId, '/debug', { level: 'verbose' });

// 5. 手动同步（如果有 replica 后端）
const results = await repo.flush();

// 6. 清理
await repo.dispose();
```

### 场景：带 Gitee replica 的浏览器应用

```typescript
import { createConfigRepo } from 'zen-fs-config';

// 后端已在 app 启动时注册好
const repo = await createConfigRepo('my-app', {
  primaryBackendId: 'local-idb',
  backendInfo: {
    type: 'IndexedDB',
    options: { storeName: 'my-app-config' },
  },
});

// 添加 Gitee 作为 replica
const backends = await repo.getBackends();
await repo.updateBackends({
  version: 1,
  backends: [
    ...backends.backends,
    {
      id: 'gitee-backup',
      type: 'Gitee',
      options: {
        owner: 'weijia',
        repo: 'my-app-backup',
        branch: 'master',
        token: 'gitee_access_token',
      },
    },
  ],
});

// 同步 .meta/ 到所有 replica，使新后端生效
await repo.syncMetaToReplicas();

// 手动 flush 触发首次同步
await repo.flush();
```
