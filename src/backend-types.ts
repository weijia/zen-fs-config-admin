export interface BackendFieldDef {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
}

export interface BackendTypeDef {
  type: string;
  label: string;
  icon: string;
  fields: BackendFieldDef[];
  defaultOptions: Record<string, string>;
}

export const BACKEND_TYPES: BackendTypeDef[] = [
  {
    type: 'InMemory',
    label: 'Memory (Browser)',
    icon: '\u{1F4BE}',
    fields: [{ key: 'label', label: 'Label', type: 'text', placeholder: 'my-configs' }],
    defaultOptions: { label: '' },
  },
  {
    type: 'GitHub',
    label: 'GitHub',
    icon: '\u{1F419}',
    fields: [
      { key: 'owner', label: 'Owner', type: 'text', placeholder: 'weijia', required: true },
      { key: 'repo', label: 'Repo', type: 'text', placeholder: 'my-configs', required: true },
      { key: 'branch', label: 'Branch', type: 'text', placeholder: 'main' },
      { key: 'token', label: 'Token', type: 'password', placeholder: 'ghp_xxxx' },
      { key: 'baseUrl', label: 'API URL', type: 'text', placeholder: 'https://api.github.com' },
    ],
    defaultOptions: { owner: '', repo: '', branch: 'main', token: '', baseUrl: '' },
  },
  {
    type: 'Gitee',
    label: 'Gitee',
    icon: '\u{1F98A}',
    fields: [
      { key: 'owner', label: 'Owner', type: 'text', placeholder: 'weijia', required: true },
      { key: 'repo', label: 'Repo', type: 'text', placeholder: 'my-configs', required: true },
      { key: 'branch', label: 'Branch', type: 'text', placeholder: 'master' },
      { key: 'token', label: 'Token', type: 'password', placeholder: 'gitee token' },
      { key: 'baseUrl', label: 'API URL', type: 'text', placeholder: 'https://gitee.com/api/v5' },
    ],
    defaultOptions: { owner: '', repo: '', branch: 'master', token: '', baseUrl: '' },
  },
  {
    type: 'WebDAV',
    label: 'WebDAV',
    icon: '\u{2601}\u{FE0F}',
    fields: [
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://dav.example.com/remote.php/dav/files/', required: true },
      { key: 'username', label: 'Username', type: 'text', placeholder: 'admin' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'rootPath', label: 'Root Path', type: 'text', placeholder: '/zen-fs-config/' },
    ],
    defaultOptions: { url: '', username: '', password: '', rootPath: '/' },
  },
];

export function getBackendTypeDef(type: string): BackendTypeDef | undefined {
  return BACKEND_TYPES.find(b => b.type === type);
}
