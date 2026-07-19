import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfigRepo } from '../context/ConfigRepoContext';
import type { ConfigRepoOptions, BackendDescriptor, SyncRule } from 'zen-fs-config';

// ---- Backend type definitions with their form fields ----

interface BackendFieldDef {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
}

interface BackendTypeDef {
  type: string;
  label: string;
  icon: string;
  fields: BackendFieldDef[];
  defaultOptions: Record<string, string>;
}

const BACKEND_TYPES: BackendTypeDef[] = [
  {
    type: 'InMemory',
    label: 'Memory (Browser)',
    icon: '💾',
    fields: [{ key: 'label', label: 'Label', type: 'text', placeholder: 'my-configs' }],
    defaultOptions: { label: '' },
  },
  {
    type: 'GitHub',
    label: 'GitHub',
    icon: '🐙',
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
    icon: '🦊',
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
    icon: '☁️',
    fields: [
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://dav.example.com/remote.php/dav/files/', required: true },
      { key: 'username', label: 'Username', type: 'text', placeholder: 'admin' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'rootPath', label: 'Root Path', type: 'text', placeholder: '/zen-fs-config/' },
    ],
    defaultOptions: { url: '', username: '', password: '', rootPath: '/' },
  },
];

interface BackendEntry {
  id: string;
  typeDef: BackendTypeDef;
  options: Record<string, string>;
  isPrimary: boolean;
}

function getBackendTypeDef(type: string): BackendTypeDef {
  return BACKEND_TYPES.find(b => b.type === type) ?? BACKEND_TYPES[0];
}

function BackendForm({ entry, onUpdate, onRemove, canRemove }: {
  entry: BackendEntry;
  onUpdate: (options: Record<string, string>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const { typeDef, options } = entry;

  return (
    <div style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 12, border: entry.isPrimary ? '1px solid var(--accent)' : '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>{typeDef.icon}</span>
          <span style={{ fontWeight: 600 }}>{typeDef.label}</span>
          {entry.isPrimary && <span className="badge badge-primary">Primary</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!entry.isPrimary && (
            <button className="btn btn-sm btn-secondary" onClick={() => onUpdate({ ...options, _setPrimary: 'true' } as any)}>Set Primary</button>
          )}
          {canRemove && <button className="btn btn-sm btn-danger" onClick={onRemove}>Remove</button>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {typeDef.fields.map(field => (
          <div key={field.key} className="form-group" style={{ margin: 0 }}>
            <label className="form-label">{field.label} {field.required && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
            {field.type === 'select' ? (
              <select
                className="form-input"
                value={options[field.key] ?? ''}
                onChange={e => onUpdate({ ...options, [field.key]: e.target.value })}
              >
                {field.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                className="form-input"
                type={field.type}
                value={options[field.key] ?? ''}
                onChange={e => onUpdate({ ...options, [field.key]: e.target.value })}
                placeholder={field.placeholder}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ConnectPage() {
  const { connect, connecting, error } = useConfigRepo();
  const navigate = useNavigate();

  const [appId, setAppId] = useState('admin');
  const [cacheTtl, setCacheTtl] = useState('60000');
  const [localError, setLocalError] = useState('');
  const [backends, setBackends] = useState<BackendEntry[]>([
    { id: 'admin-primary', typeDef: BACKEND_TYPES[0], options: { label: 'admin' }, isPrimary: true },
  ]);

  const addBackend = () => {
    const id = `backend-${Date.now()}`;
    setBackends([...backends, {
      id,
      typeDef: BACKEND_TYPES[0],
      options: { ...BACKEND_TYPES[0].defaultOptions },
      isPrimary: false,
    }]);
  };

  const updateBackend = (index: number, updates: Partial<BackendEntry>) => {
    const next = [...backends];
    if (updates.typeDef) {
      // Switched backend type — reset options
      next[index] = { ...next[index], ...updates, options: { ...updates.typeDef.defaultOptions } };
    } else {
      next[index] = { ...next[index], ...updates };
    }

    // Handle set primary
    if ((updates.options as any)?._setPrimary === 'true') {
      next.forEach((b, i) => { b.isPrimary = i === index; });
      delete (next[index].options as any)._setPrimary;
    }

    setBackends(next);
  };

  const removeBackend = (index: number) => {
    setBackends(backends.filter((_, i) => i !== index));
  };

  const changeBackendType = (index: number, type: string) => {
    const typeDef = getBackendTypeDef(type);
    updateBackend(index, { typeDef });
  };

  const handleConnect = async () => {
    setLocalError('');
    if (!appId.trim()) { setLocalError('App ID is required'); return; }

    const primary = backends.find(b => b.isPrimary) ?? backends[0];
    const primaryFieldKeys = primary.typeDef.fields.filter(f => f.required).map(f => f.key);
    for (const key of primaryFieldKeys) {
      if (!primary.options[key]?.trim()) {
        setLocalError(`Primary backend missing required field: ${key}`);
        return;
      }
    }

    try {
      // Build bootstrap data with all backends and sync rules
      const backendDescriptors: Omit<BackendDescriptor, 'description'>[] = backends.map(b => ({
        id: b.id,
        type: b.typeDef.type,
        options: { ...b.options },
      }));

      const syncRules: SyncRule[] = [
        {
          prefix: `/${appId.trim()}/`,
          direction: 'one-way' as any,
          conflictStrategy: 'source-wins' as any,
          replicas: backends.filter(b => !b.isPrimary).map(b => b.id),
        },
        {
          prefix: '/shared/',
          direction: 'bi-directional' as any,
          conflictStrategy: 'merge' as any,
          replicas: backends.map(b => b.id),
        },
        { prefix: '/nodes/', direction: 'none' as any },
        { prefix: '/.meta/', direction: 'none' as any },
      ];

      const options: ConfigRepoOptions = {
        primaryBackendId: primary.id,
        backendInfo: {
          type: primary.typeDef.type,
          options: { ...primary.options },
        },
        cache: { storeType: 'MemoryCacheStore', ttlMs: parseInt(cacheTtl) || 60000 },
        bootstrap: {
          backends: backendDescriptors,
          syncRules,
        },
      };

      await connect(appId.trim(), options);
      navigate('/dashboard');
    } catch (err: any) {
      setLocalError(err.message || String(err));
    }
  };

  return (
    <div className="connect-page">
      <div className="connect-card" style={{ maxWidth: 640 }}>
        <h1>zen-fs-config-admin</h1>
        <p className="subtitle">Configure backends and connect</p>

        {/* App ID */}
        <div className="form-group">
          <label className="form-label">App ID</label>
          <input className="form-input" value={appId} onChange={e => setAppId(e.target.value)} placeholder="admin" />
        </div>

        {/* Cache TTL */}
        <div className="form-group">
          <label className="form-label">Cache TTL (ms)</label>
          <input className="form-input" type="number" value={cacheTtl} onChange={e => setCacheTtl(e.target.value)} />
          <p className="form-hint">0 = always revalidate, 60000 = 60s cache</p>
        </div>

        {/* Backend list */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <label className="form-label" style={{ margin: 0 }}>Backends</label>
          <button className="btn btn-sm btn-secondary" onClick={addBackend}>+ Add Backend</button>
        </div>

        {backends.map((entry, index) => (
          <div key={entry.id}>
            <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label className="form-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>#{index + 1} Type</label>
              <select
                className="form-input"
                value={entry.typeDef.type}
                onChange={e => changeBackendType(index, e.target.value)}
                style={{ flex: 1 }}
              >
                {BACKEND_TYPES.map(bt => (
                  <option key={bt.type} value={bt.type}>{bt.icon} {bt.label}</option>
                ))}
              </select>
              <label className="form-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>ID</label>
              <input
                className="form-input"
                value={entry.id}
                onChange={e => {
                  const next = [...backends];
                  next[index] = { ...next[index], id: e.target.value };
                  if (next[index].isPrimary) {
                    // Will be used as primaryBackendId
                  }
                  setBackends(next);
                }}
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
            </div>
            <BackendForm
              entry={entry}
              onUpdate={opts => updateBackend(index, { options: opts })}
              onRemove={() => removeBackend(index)}
              canRemove={backends.length > 1}
            />
          </div>
        ))}

        {/* Error */}
        {(localError || error) && (
          <div style={{ margin: '16px 0', padding: '8px 12px', background: 'var(--danger-bg)', borderRadius: 'var(--radius)', color: 'var(--danger)', fontSize: 13 }}>
            {localError || error}
          </div>
        )}

        {/* Connect */}
        <button
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', padding: '10px', marginTop: 8 }}
          disabled={connecting}
          onClick={handleConnect}
        >
          {connecting ? 'Connecting...' : 'Connect'}
        </button>
      </div>
    </div>
  );
}