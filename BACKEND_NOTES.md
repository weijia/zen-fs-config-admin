# Backend Configuration Notes

This document collects known behaviors, pitfalls, and best practices for each backend type supported by zen-fs-config-admin.

---

## IndexedDB

| Item | Detail |
|------|--------|
| **Type** | Browser-local |
| **Persistence** | Yes (within browser profile) |
| **CORS** | N/A |

- **Privacy mode**: IndexedDB may be unavailable or cleared when the browser is in private/incognito mode.
- **Quota**: Subject to browser storage limits (typically ~50-60% of available disk space).
- **Migration**: Data is tied to the origin (hostname + port). Moving to a different domain requires manual export/import.

---

## WebStorage (localStorage)

| Item | Detail |
|------|--------|
| **Type** | Browser-local |
| **Persistence** | Yes (within browser profile) |
| **CORS** | N/A |

- **Size limit**: ~5-10 MB total per origin.
- **Blocking**: Synchronous API may block the main thread with large files.
- **Best for**: Small configs, testing, or as a fallback.

---

## RemoteStorage

| Item | Detail |
|------|--------|
| **Type** | Cloud (WebDAV-like over HTTP) |
| **Persistence** | Server-side |
| **CORS** | Required |

### Path handling

- `basePath` is **automatically normalized** by the backend:
  - Always starts with `/`
  - Always ends with `/`
  - So `/weijia/app_data/configs` and `/weijia/app_data/configs/` are equivalent.
- `href` (server URL) should **NOT** end with `/` — the backend strips it automatically.

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `GET ... 404` | Directory URL missing trailing `/` | Backend now auto-normalizes basePath |
| `File not found: /` | Remote directory does not exist yet | Backend now returns `[]` on 404 |
| CORS errors | Server missing `Access-Control-Allow-Origin` | Configure CORS on your RemoteStorage server |

### Notes

- RemoteStorage spec requires directory listing URLs to end with `/`.
- The backend uses `application/ld+json` for directory listings.
- If the remote directory is empty or does not exist, `readdir()` returns `[]` (not an error).

---

## Gitee

| Item | Detail |
|------|--------|
| **Type** | Git hosting (China) |
| **Persistence** | Git repository |
| **CORS** | N/A (server-side API) |

### Required token scope

- `projects` (to read/write repository contents)
- `pull_requests` (if you plan to use PR-based workflows)

### Path handling

- `branch` parameter must be passed in the **URL query string**, not the request body.
  - Fixed in `zen-fs-gitee >= 1.0.2`.
- Default branch is `master`. If your repo uses `main`, set it explicitly.

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `只允许在分支上创建或更新文件` (400) | `branch` sent in body instead of URL query | Update `zen-fs-gitee` to latest |
| `404 Not Found` | Branch does not exist | Create branch on Gitee first, or let backend auto-create |

### Notes

- Empty repositories (no branches) are handled: the backend creates an initial `.gitkeep` file to bootstrap the branch.
- Gitee API v5 has rate limits: 5000 requests/hour for authenticated users.

---

## GitHub

| Item | Detail |
|------|--------|
| **Type** | Git hosting |
| **Persistence** | Git repository |
| **CORS** | N/A (server-side API) |

### Required token scope

- `repo` (full repository access)
- For public repos only: `public_repo`

### Path handling

- Similar to Gitee, but GitHub API v3 accepts `branch` in both query and body.
- Default branch is usually `main` for new repos.

### Notes

- Rate limit: 5000 requests/hour for authenticated users, 60 for unauthenticated.
- Large files (>100MB) require Git LFS — not supported by this backend.

---

## WebDAV

| Item | Detail |
|------|--------|
| **Type** | Cloud (HTTP extension) |
| **Persistence** | Server-side |
| **CORS** | Required if server is on a different origin |

### Notes

- Ensure your WebDAV server supports `PROPFIND` and `PUT` methods.
- CORS preflight requests may require the server to respond to `OPTIONS`.
- Authentication: typically Basic Auth or Bearer token in the URL.

---

## InMemory

| Item | Detail |
|------|--------|
| **Type** | Volatile |
| **Persistence** | No |
| **CORS** | N/A |

- **Use case**: Testing, ephemeral sessions, or as a scratch pad.
- **Data loss**: All data is lost on page refresh or tab close.

---

## General Best Practices

1. **Always test connectivity** before saving a backend config. The admin UI shows a connection indicator.
2. **Use HTTPS** for all cloud backends to prevent token interception.
3. **Token rotation**: Store tokens in environment variables or secure vaults, never commit them to Git.
4. **Primary backend**: Choose a reliable backend (IndexedDB for local-first, RemoteStorage for cloud-first) as the primary.
5. **Replica backends**: Add replicas only after the primary is stable. Each replica adds sync overhead.
6. **Base path trailing slash**: When in doubt, include it. Most backends normalize it, but some (like RemoteStorage) are sensitive.

---

## Sync Behavior Summary

| Aspect | Behavior |
|--------|----------|
| Same Pair | Serial (`sync()` has state guard) |
| Files within Pair | Serial (`for...of` loop) |
| Multiple Pairs | Parallel (`Promise.all`) |
| Admin `syncOnceAndStop` | Serial (pairs synced one by one) |

---

*Last updated: 2026-07-21*
