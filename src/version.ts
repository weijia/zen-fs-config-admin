import versionInfo from './version.json';

export const VERSION = versionInfo.version;
export const BUILD_TIME = versionInfo.buildTime;
export const COMMIT_SHA = versionInfo.sha;

export const versionDisplay = `${VERSION} (${COMMIT_SHA})`;
export const buildTimeDisplay = BUILD_TIME;
