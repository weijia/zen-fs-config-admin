# 集成测试文档：数据同步组（Data Sync Groups）

> 需求 [`../REQUIREMENTS.md`](../REQUIREMENTS.md) ·
> 设计 [`../DESIGN.md` §11](../DESIGN.md)

## 1. 测试分层

| 层 | 位置 | 环境 | 覆盖 |
|----|------|------|------|
| 单元 | `src/__tests__/data-groups.test.ts` | Node + vitest，注入假 repo | FR1.1–FR1.8、FR3 的纯逻辑 |
| 单元 | `src/__tests__/files-data-group-path.test.ts` | Node + vitest | FR2.7 路径编解码 |
| 集成 | 手工 / 浏览器（见第 3 节） | 真实浏览器 + 真实后端 | FR1、FR2、FR3 全链路 |

admin 此前没有测试框架；本次按「以仓库现有为准，必要时补配置」的原则
补上 **vitest**（与 `zen-fs-config` 一致），并加 `npm test` / `npm run test:watch`。

## 2. 单元测试

### 2.1 `activateDataGroups()`（`src/context/ConfigRepoContext.tsx` 导出）

用假 repo 验证「枚举 → 激活」逻辑：

| # | 用例 | 断言 |
|---|------|------|
| A1 | 无数据组 | 返回 `[]`，不抛错 |
| A2 | 有 2 个组 | `getAppDataGroup` 被调用 2 次，返回 2 条 `DataGroupInfo`，`backends` 来自 `listBackends()` |
| A3 | 其中 1 个组 `getAppDataGroup` 抛错 | 仍返回 2 条，失败那条带 `error`，另一条正常 |
| A4 | `listAppDataGroups()` 抛错 | 返回 `[]`，不向上抛 |
| A5 | 只处理 `appId='admin'`（由 repo 保证） | 假 repo 只暴露 admin 的组 |

### 2.2 Context 生命周期

用 React Testing Library 渲染 `ConfigRepoProvider`（`createConfigRepo` 用 vi.mock 替换为假 repo）：

| # | 用例 | 断言 |
|---|------|------|
| B1 | 挂载后 | `listAppDataGroups` + `getAppDataGroup` 被调用；`dataGroups` 被填充 |
| B2 | 卸载后 | 每个组的 `dispose()` 被调用一次；`repo.dispose()` 被调用 |
| B3 | `reconnect()` | 旧组 `dispose()` → 旧 repo `dispose()` → 新 repo 上重新 `getAppDataGroup` |
| B4 | `getDataGroupFs(id)` | 返回 `group.fs.promises`（或 `group.fs`） |
| B5 | `refreshDataGroups()` | 重新枚举并填充 |

### 2.3 数据组路径编解码（`src/pages/FilesPage.tsx` 导出）

| # | 用例 | 断言 |
|---|------|------|
| C1 | `isDataGroupPath('/@dg')` | true |
| C2 | `isDataGroupPath('/@dg/g1/a.txt')` | true |
| C3 | `isDataGroupPath('/admin/a.json')` | false |
| C4 | `parseDataGroupPath('/@dg/g1/sub/a.txt')` | `{ groupId: 'g1', inner: '/sub/a.txt' }` |
| C5 | `parseDataGroupPath('/@dg/g1')` | `{ groupId: 'g1', inner: '/' }` |
| C6 | `makeDataGroupPath('g1', '/sub/a.txt')` | `/@dg/g1/sub/a.txt` |
| C7 | `makeDataGroupPath('g1', '/')` | `/@dg/g1` |
| C8 | 往返：`parse(make(g, p))` | 还原出同样的 `g` 与 `p` |

## 3. 集成测试（真实环境）

### 3.1 前置

```bash
cd zen-fs-config-admin
npm install
npm run dev      # 浏览器打开 http://localhost:5173
```

准备至少两个可写的远端后端（任选其二）：
RemoteStorage（5apps / 自建）、Gitee、GitHub、WebDAV（本地 `ugeek/webdav` 容器即可）。

### 3.2 用例

| # | 场景 | 步骤 | 期望 |
|---|------|------|------|
| I1 | 自动激活 | ① 在无数据组时启动 admin<br>② 在另一个客户端（或手工写 `.meta/app-data-groups/admin/g1.json`）创建数据组<br>③ 刷新 admin | 状态栏 / Data Groups 页出现 `g1`，且无错误 |
| I2 | 自动同步 | ① 在 Data Groups 页创建组 `g1`，后端 A / B 各一个<br>② 在文件浏览器 `Data Groups → g1` 下新建文件 `a.txt` 并保存 | 文件出现在后端 A 与后端 B（可直接用 Web / WebDAV 客户端查看） |
| I3 | 远端变更回流 | ① 用外部工具在后端 A 上改 `a.txt`<br>② 等待一个轮询周期（默认 30 min，可在控制台调低）或在 Data Groups 页点 Flush | 文件浏览器里 `g1/a.txt` 内容更新 |
| I4 | 文件树 | 根下出现 **Data Groups** 节点 → 展开看到 `g1` → 再展开看到组内目录树 | 与配置仓节点并列，配置仓分支行为不变 |
| I5 | 组内编辑 | 打开 `Data Groups → g1 → a.txt`，修改并保存 | 保存成功；**不显示** version 徽标（数据组无 `.version` 体系） |
| I6 | 组内加后端 | Data Groups 页 → `g1` → “+ Backend” → 填后端 C → Add | 列表出现后端 C；后端 C 上出现 `a.txt` |
| I7 | 组内删后端 | 对后端 C 点 ✕ | 列表移除；后端 C 上的同步对停止 |
| I8 | 删除组 | Remove → Confirm | 组从列表消失；文件树 Data Groups 下不再有该组 |
| I9 | Reconnect | 顶栏点 Reconnect | 数据组被重新激活（日志出现 `activated "..."`）；同步对数量不翻倍（无重复 SyncPair） |
| I10 | 单组失败隔离 | 把某组的后端 token 改成无效值后 Reconnect | 该组显示 error，其它组与配置仓仍正常 |

### 3.3 日志核对

浏览器控制台（或 vConsole）关注以下模块：

- `admin:config-repo-context` —— `activated "<groupId>" (N backend(s))`
- `admin:data-groups` —— CRUD 操作结果
- `zen-fs-config:config-repo` / `zen-fs-sync:sync` —— 同步对建立与同步结果

## 4. 运行

```bash
cd zen-fs-config-admin
npm test          # vitest run（单元）
npm run test:watch
npm run lint
npx tsc -b --force
```

## 5. 验收对照

| todo.md 验收项 | 覆盖 |
|----------------|------|
| 自动激活并同步所有数据组 | A1–A5、B1、I1–I3 |
| 文件浏览器 Data Groups 节点可查看/编辑 | C1–C8、I4、I5 |
| reconnect / dispose 正确重建 / 释放 | B2、B3、I9 |
| 单元 + 集成测试 | 第 2 / 3 节 |
| CRUD（Q1） | I6–I8 |
