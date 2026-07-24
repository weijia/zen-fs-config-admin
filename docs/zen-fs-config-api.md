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
  /** 可选：传入的后端 ID（作为 replica 添加） */
  primaryBackendId?: string;

  /** 可选：传入的后端连接信息（作为 replica 添加到本地 IndexedDB） */
  backendInfo?: {
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

  /** IndexedDB store 名称（默认: `zen-fs-config-{appId}`） */
  idbStoreName?: string;
}
```

> **架构说明**: `createConfigRepo` **始终** 创建一个本地 IndexedDB 作为主后端（ID 为 `"local-idb"`），所有配置操作直接在 IndexedDB 上执行，确保本地访问速度。如果传入了 `backendInfo`，该后端会被添加为 **replica**（副本），用于同步备份。不再需要指定外部后端作为主后端。

#### `backendInfo` (可选)

**类型**: `{ type: string; options: Record<string, unknown> }`  
**必填**: 否

如果提供了 `backendInfo`，这个后端会被创建为一个 **replica**（副本），与本地 IndexedDB 主后端进行双向同步。

**示例**：创建一个带 Gitee 同步的配置仓库：

```typescript
const repo = await createConfigRepo('admin', {
  primaryBackendId: 'my-gitee',
  backendInfo: {
    type: 'Gitee',
    options: { owner: 'weijia', repo: 'configs', branch: 'master', token: 'xxx' },
  },
});
// → IndexedDB 是主后端（ID: "local-idb"）
// → Gitee 是 replica（ID: "my-gitee"）
// → 配置在本地读写，flush 时同步到 Gitee
```

不传 `backendInfo` 也可以正常创建（纯本地模式）：

```typescript
const repo = await createConfigRepo('admin', {});
// → 只有 IndexedDB 主后端，无远程同步
```

#### `idbStoreName` (可选)

**类型**: `string`  
**默认值**: `'zen-fs-config-{appId}'`

本地 IndexedDB 的 store 名称。不同 appId 默认使用不同的 store，避免数据冲突。

#### `backendInfo.type`

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

所以创建 Gitee **replica** 后端的配置是：

```typescript
const repo = await createConfigRepo('admin', {
  primaryBackendId: 'my-gitee',        // replica 的 ID
  backendInfo: {
    type: 'Gitee',
    options: {
      owner: 'weijia',
      repo: 'my-configs',
      branch: 'master',
      token: 'xxx',
    },
  },
});
// IndexedDB 是主后端（自动创建），Gitee 是 replica
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
// 读取后端配置（从 .meta/backends/ 目录读取每个后端文件）
const backends = await repo.getBackends();
// → { version: 1, backends: [{ id: 'local-idb', type: 'IndexedDB', ... }, ...] }

// 动态添加 replica 后端（自动创建 sync pair）
await repo.addBackend('my-webdav', 'WebDAV', { url: 'https://dav.example.com' }, 'My WebDAV backup');
// → 自动创建后端实例，注册双向同步，写入 .meta/backends/my-webdav.json

// 动态移除 replica 后端（自动清理 sync pair）
await repo.removeBackend('my-webdav');
// → 移除 sync pair，dispose 后端实例，删除配置文件
// 注意：不能移除 primary backend ('local-idb')

// 也可以用低级 API 直接操作：
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

调用 `createConfigRepo` 时，内部会：

1. **始终创建 IndexedDB** 作为主后端（ID: `"local-idb"`）
2. 读取 `.meta/backends/` 目录中每个非 primary 且非 disabled 的后端配置
3. 对于每个 replica 后端：
   - 用 `createBackend()` 创建后端实例
   - 用 `backendToSyncableFS()` 包装成 `SyncableFS`
   - 在 `syncEngine` 中注册一个双向同步 pair：
     - `source` = `fullFS`（IndexedDB 主后端 + cache 层）
     - `target` = replica 后端
     - `direction` = `BiDirectional`
     - `conflictStrategy` = `source-wins`（IndexedDB 内容优先）
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
    ├── backends.json           # 后端拓扑配置（向后兼容，自动生成）
    ├── backends/               # 每个后端一个独立配置文件
    │   ├── local-idb.json     # 主后端（IndexedDB，自动创建）
    │   ├── my-gitee.json      # Gitee replica（如果配置了的话）
    │   └── my-webdav.json     # WebDAV replica（如果配置了的话）
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

---

## 最简用例（5 个场景）

以下每个场景都是独立的最简示例，展示了 zen-fs-config 的核心生命周期。

### 场景 1：初始化（纯本地）

第一次创建配置仓库。不需要传任何后端参数，`createConfigRepo` 会自动创建本地 IndexedDB 作为主后端。

```typescript
import { createConfigRepo } from 'zen-fs-config';

const repo = await createConfigRepo('my-app', {});
// → 自动创建 IndexedDB 主后端（store: "zen-fs-config-my-app"）
// → 无远程 replica

console.log('appId:', repo.appId);       // 'my-app'
console.log('nodeId:', repo.nodeId);     // 'node-xxx'（自动生成）

await repo.dispose();
```

> 不传 `backendInfo` 就是纯本地模式，数据只存在浏览器 IndexedDB 中。

### 场景 1b：初始化（带远程同步）

创建配置仓库的同时指定一个远程后端作为 replica。

```typescript
import { createConfigRepo } from 'zen-fs-config';
// 前提：已注册 IndexedDB 和 Gitee 后端类型

const repo = await createConfigRepo('my-app', {
  primaryBackendId: 'my-gitee',
  backendInfo: {
    type: 'Gitee',
    options: { owner: 'weijia', repo: 'configs', branch: 'master', token: 'xxx' },
  },
});
// → IndexedDB 是主后端（自动创建）
// → Gitee 是 replica，flush 时双向同步

await repo.dispose();
```

### 场景 2：设置新的配置

写入一条配置，然后读回来。

```typescript
import { createConfigRepo } from 'zen-fs-config';

const repo = await createConfigRepo('my-app', {
  primaryBackendId: 'local',
  backendInfo: { type: 'InMemory', options: {} },
});

// 写入配置（同步写入内存缓存，后台异步持久化到后端）
repo.setConfig('/database', { host: 'localhost', port: 5432 });

// 读取配置（同步，从内存缓存读）
const db = repo.getConfig<{ host: string; port: number }>('/database');
console.log(db.host); // 'localhost'

// 也可以用 fs API 直接读文件
const raw = await repo.fs.promises.readFile('/database.json', 'utf-8');
console.log(JSON.parse(raw).port); // 5432

await repo.dispose();
```

### 场景 3：增加数据后端

在已有主后端的基础上，添加一个 Gitee 作为副本后端，实现数据冗余。

```typescript
import { createConfigRepo } from 'zen-fs-config';

const repo = await createConfigRepo('my-app', {});
// IndexedDB 主后端自动创建

// 先写入一些配置
repo.setConfig('/database', { host: 'localhost', port: 5432 });

// 动态添加 Gitee replica（自动创建 sync pair）
await repo.addBackend(
  'gitee-backup',           // ID
  'Gitee',                  // type
  {
    owner: 'weijia',
    repo: 'my-configs',
    branch: 'master',
    token: 'your_token',
  },
  'My Gitee backup'         // description（可选）
);

// 首次同步：将本地配置推送到 Gitee
await repo.flush();

console.log('replica 已添加并同步');
await repo.dispose();
```

### 场景 4：自动同步

配置写入后，数据会自动同步到所有副本后端。

```typescript
import { createConfigRepo } from 'zen-fs-config';

const repo = await createConfigRepo('my-app', {
  primaryBackendId: 'local',
  backendInfo: { type: 'InMemory', options: {} },
});

// 假设已经添加了 Gitee 副本（见场景 3）

// 写入新配置 → 自动触发后台持久化到主后端
repo.setConfig('/feature-flags', { newUI: true, beta: false });

// 手动触发同步，将主后端的变更推送到所有副本
const results = await repo.flush();
for (const r of results) {
  console.log(`${r.pairId}: +${r.filesCreated} ~${r.filesUpdated} -${r.filesDeleted}`);
  // 输出示例: local→gitee-backup: +1 ~0 -0
}

// 查看同步状态
const statuses = repo.getSyncStatuses();
for (const [pairId, status] of statuses) {
  console.log(`${pairId}: state=${status.state}, totalSyncs=${status.totalSyncs}`);
}

await repo.dispose();
```

### 场景 5：再次打开时初始化

应用关闭后重新打开，连接到同一个后端，恢复之前的配置。

```typescript
import { createConfigRepo } from 'zen-fs-config';

// === 第一次运行 ===
{
  const repo = await createConfigRepo('my-app', {
    primaryBackendId: 'local',
    backendInfo: { type: 'InMemory', options: {} },
  });

  repo.setConfig('/database', { host: 'localhost', port: 5432 });

  await repo.dispose();
}

// === 第二次运行（重新连接同一个后端）===
{
  // 用相同（或更少）的参数再次调用 createConfigRepo
  // IndexedDB 是主后端，数据持久保存在浏览器中
  // createConfigRepo 会读取 IndexedDB 上的 /.meta/backends/ 恢复拓扑
  const repo = await createConfigRepo('my-app', {});

  // load() 会自动将后端上的配置加载到内存缓存
  // 直接读取之前的配置
  const db = repo.getConfig<{ host: string; port: number }>('/database');
  console.log(db); // { host: 'localhost', port: 5432 }

  await repo.dispose();
}
```

> 重新连接时，`createConfigRepo` 会自动：
> 1. 创建 IndexedDB 主后端（数据持久保存在浏览器中）
> 2. 读取 `.meta/backends/` 目录恢复后端拓扑
> 3. 读取 `.meta/.node-id` 恢复节点 ID
> 4. 调用 `load()` 将配置文件加载到内存缓存
> 5. 如果有 replica 后端，做一次同步
