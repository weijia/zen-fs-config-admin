# zen-fs-config-admin：支持数据同步组（自动同步 + 文件浏览器浏览）

> 本文件是 `../todo.md` 中「项目 1」的详细分析。需求与状态以 `todo.md` 为准。

## 一、需求（Richard 澄清后）
- admin 原本会自动同步「配置同步组（配置仓）」；现在要**额外自动同步**
  `app-data-groups` 下面、**相同应用（`APP_ID='admin'`）** 的数据同步组
  的后端之间也要能同步。
- 文件浏览器在现有树根下加一个 **“Data Groups”** 节点，展开可见各数据组的
  目录树（并入现有树，非独立页/切换器）。
- 不要求 admin 自身作为数据组副本参与同步。

## 二、现状分析（已确认事实，非假设）
- `zen-fs-config` 已提供数据组能力（`src/config-repo.ts`）：
  - `listAppDataGroups()` / `getAppDataGroup(id)` / `createAppDataGroup()` /
    `removeAppDataGroup()`。
  - 描述符位于 `.meta/app-data-groups/{appId}/{id}.json`，`groupType:'data-sync'`。
  - 每个 `AppDataGroup` 有 `readonly fs`（`zen-fs-config/src/types.ts`），可
    直接 `group.fs.promises` 读写。
  - `AppDataGroupImpl.init()`：建本地主副本 → 为每个后端建双向 `SyncPair`
    → `syncAll()` → `watchAll()`。**只有被 `getAppDataGroup(id)` 实例化时
    才启动同步**；`appDataGroups` map 默认空，admin 当前从不调用这些方法，
    故数据组现在不会被自动同步。
- admin 当前只连一个配置仓（`src/context/ConfigRepoContext.tsx` 固定
  `APP_ID='admin'`、`createConfigRepo`），只渲染该配置仓
  （`src/pages/FilesPage.tsx` 用 `repo.rootFS.promises`）。
- 连接流程在 `ConfigRepoContext` 的 `createRepo()` / `reconnect()`，目前没有
  「枚举并激活数据组」这一步。

## 三、任务分解（可执行）
1. 需求/设计文档：在 admin 内新建/并入 REQUIREMENTS 与 DESIGN，写清
   「数据组自动同步 + Data Groups 节点」需求、交互、context 新增字段、Files
   树新增虚拟根节点。（admin 当前**无** REQUIREMENTS.md，需新建；测试框架
   以仓库现有为准，待确认见第四节。）
2. 自动同步数据组（核心改动 `src/context/ConfigRepoContext.tsx`）：
   - `createRepo()` 拿到 `repo` 并 `setRepo` 后，枚举并激活：
     ```ts
     const groups = await repo.listAppDataGroups();
     for (const g of groups) { try { await repo.getAppDataGroup(g.id); } catch {} }
     ```
     这会让每个数据组的 `init()` 跑起来（初始同步 + watch）。
   - 把激活后的数据组句柄（id + `group.fs` + 同步状态）暴露到 context
     （如 `dataGroups` 数组 / `getDataGroupFs(id)`），供文件浏览器与（可选）
     状态展示使用。
   - `reconnect()` 与 dispose 时相应重新激活 / 释放数据组，避免重复 SyncPair
     或泄漏。
   - 作用域：只处理 `appId==='admin'` 的数据组，与配置仓一致。
2.5 数据组管理 UI（CRUD，Richard 确认需要）：
   - 列表：展示 `repo.listAppDataGroups()` 结果（id / 后端数 / 同步状态）。
   - 创建：表单收集 `id` 与若干后端（`type`+`options`），调用
     `repo.createAppDataGroup(id, backends)`；后端类型与表单元数据复用
     `register-backends.ts` 已有的（GitHub/Gitee/WebDAV/RemoteStorage…）。
   - 删除：调用 `repo.removeAppDataGroup(id)`，并释放对应实例 / 同步对。
   - 后端增删：对选中组调用其 `addBackend` / `removeBackend`（API 以
     `AppDataGroup` 接口为准），刷新同步对与文件树。
3. 文件浏览器并入 “Data Groups” 节点（`src/pages/FilesPage.tsx`）：
   - 现有 `loadChildren(fs, dir)` / `FileTree` / `TreeNodeView` 已是通用
     `fs.promises` 实现，只需把「当前 fs 来源」参数化：
     · 配置仓分支 → `repo.rootFS.promises`（现状不变）；
     · Data Groups 下某组分支 → `group.fs.promises`
       （经 context `getAppDataGroup(id)`，已缓存）。
   - 根下新增虚拟目录节点 “Data Groups”；展开列各数据组（组 id 作子目录），
     再展开某组加载该组 `group.fs.promises` 目录树。
   - 组内文件查看/编辑复用现有编辑器；注意组的 fs 没有配置仓的 `.version`
     sidecar 体系，`versionInfo` 那段对组数据应跳过。
4. 集成测试文档 + 测试：
   - 单元测试：用 `zen-fs-config` 的 InMemory 配置仓造数据组，断言 admin 的
     「枚举→激活→取 fs」逻辑。
   - 集成测试：用本地可跑的数据后端（本地目录后端 / 测试用 WebDAV 或
     RemoteStorage）验证「admin 启动 → 数据组被自动同步 → Data Groups 节点
     看到结构 → 远端改动经 watch 反映到本地」。

## 四、验收标准
- [ ] admin 连上配置仓后，自动激活并同步 `appId='admin'` 下的所有数据同步组
      （初始同步 + watch，与配置仓一致）。
- [ ] 文件浏览器根下出现 “Data Groups” 节点，展开可见各数据组目录树，可查看/编辑。
- [ ] reconnect / dispose 时数据组随之正确重建 / 释放，无泄漏或重复 SyncPair。
- [ ] 有单元测试 + 集成测试覆盖。

## 五、已确认决策（Q&A 回填）
- Q1（范围）: **需要 CRUD 管理**——除自动同步 + 在 “Data Groups” 节点浏览外，
  admin 还需通过 UI **创建/删除数据组、增删其后端**。具体调用
  `zen-fs-config` 暴露的 `createAppDataGroup` / `removeAppDataGroup` /
  数据组的 `addBackend` / `removeBackend`（确切 API 以 ConfigRepo / AppDataGroup
  接口为准，开发时核对），操作后刷新同步对与文件树。
- Q2（工程基线）: admin 当前无 REQUIREMENTS.md，新建独立 `REQUIREMENTS.md`；
  测试框架以仓库现有为准（实现前核对 package.json 的 test 脚本，必要时补配置）。
