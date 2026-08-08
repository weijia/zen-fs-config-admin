import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './patch-stat-cache.ts'
import App from './App.tsx'
import { version, buildTime, deps } from './version.json'
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('admin:main');

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