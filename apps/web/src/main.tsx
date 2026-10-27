import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import { initTheme } from "./lib/theme";
initTheme();
import { AuthProvider, useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Live } from "./pages/Live";
import { Layouts } from "./pages/Layouts";
import { Playback } from "./pages/Playback";
import { Events } from "./pages/Events";
import { Cameras } from "./pages/Cameras";
import { Groups } from "./pages/Groups";
import { Nvrs } from "./pages/Nvrs";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10000 } } });

function Guarded() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-sm text-zinc-500">กำลังโหลด…</div>;
  if (!user) return <Login />;
  return <Layout />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Guarded />}>
              <Route index element={<Dashboard />} />
              <Route path="live" element={<Live />} />
              <Route path="layouts" element={<Layouts />} />
              <Route path="playback" element={<Playback />} />
              <Route path="events" element={<Events />} />
              <Route path="cameras" element={<Cameras />} />
              <Route path="groups" element={<Groups />} />
              <Route path="nvrs" element={<Nvrs />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
