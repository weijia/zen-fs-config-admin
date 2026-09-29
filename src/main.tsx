import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './patch-stat-cache.ts'
import App from './App.tsx'
import { version, buildTime, deps } from './version.json'
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('admin:main');

// 一次性调试开关初始化：仅在浏览器首次运行时设置一次，之后不覆盖，
// 便于排查 .version 冗余 PUT（可随时在 DevTools 手动改这些值做对比）。
const DEBUG_SENTINEL = 'debug:__admin_setup_v1__';
if (!localStorage.getItem(DEBUG_SENTINEL)) {
	localStorage.setItem('debug:zen-fs-config:config-repo', '1');
	localStorage.setItem('debug:sync', '1');
	localStorage.setItem('debug:detector', '0');
	localStorage.setItem('debug:folder-backend', '0');
	localStorage.setItem('debug:data-sync-group', '0');
	localStorage.setItem('debug:connect', '0');
	localStorage.setItem(DEBUG_SENTINEL, '1');
}

log.log(
  `%c zen-fs-config-admin %c ${version} %c ${buildTime} `,
  'background:#35495e; color:#fff; padding:2px 4px; border-radius:3px 0 0 3px;',
  'background:#41b883; color:#fff; padding:2px 4px;',
  'background:#35495e; color:#fff; padding:2px 4px; border-radius:0 3px 3px 0;',
);
log.log('Dependencies:');
Object.entries(deps).forEach(([name, ver]) => {
  log.log(`  ${name}: ${ver}`);
});
log.log('To enable RemoteStorage debug logging, run:');
log.log('  window.__RS_DEBUG = true');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)