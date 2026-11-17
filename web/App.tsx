import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from '@web/state/AppContext';
import { AppShell, BootScreen, NotFound } from '@web/components/layout';
import Dashboard from '@web/pages/Dashboard';
import NewClips from '@web/pages/NewClips';
import ProjectPage from '@web/pages/ProjectPage';
import Library from '@web/pages/Library';
import Live from '@web/pages/Live';
import Campaigns from '@web/pages/Campaigns';
import Settings from '@web/pages/Settings';

function AppRoutes() {
  const { loading, error, bootstrap, refresh } = useApp();

  useEffect(() => {
    document.title = 'TeraClip Studio — local AI clipping';
  }, []);

  if (loading && !bootstrap) return <BootScreen />;
  if (error && !bootstrap) return <BootScreen error={error} onRetry={() => void refresh()} />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="new" element={<NewClips />} />
        <Route path="project/:id" element={<ProjectPage />} />
        <Route path="library" element={<Library />} />
        <Route path="live" element={<Live />} />
        <Route path="campaigns" element={<Campaigns />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <AppRoutes />
      </AppProvider>
    </BrowserRouter>
  );
}
