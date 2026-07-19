import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigRepoProvider, useConfigRepo } from './context/ConfigRepoContext';
import Layout from './components/Layout';
import ConnectPage from './pages/ConnectPage';
import DashboardPage from './pages/DashboardPage';
import FilesPage from './pages/FilesPage';
import BackendsPage from './pages/BackendsPage';
import SyncRulesPage from './pages/SyncRulesPage';
import ConflictsPage from './pages/ConflictsPage';
import NodesPage from './pages/NodesPage';

function AppRoutes() {
  const { connected } = useConfigRepo();

  if (!connected) {
    return (
      <Routes>
        <Route path="/connect" element={<ConnectPage />} />
        <Route path="*" element={<Navigate to="/connect" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/files/*" element={<FilesPage />} />
        <Route path="/backends" element={<BackendsPage />} />
        <Route path="/sync-rules" element={<SyncRulesPage />} />
        <Route path="/conflicts" element={<ConflictsPage />} />
        <Route path="/nodes" element={<NodesPage />} />
        <Route path="/connect" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ConfigRepoProvider>
        <AppRoutes />
      </ConfigRepoProvider>
    </BrowserRouter>
  );
}