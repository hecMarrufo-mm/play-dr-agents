import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import GalleryPage from './pages/GalleryPage';
import AgentChatPage from './pages/AgentChatPage';
import CreateEditAgentPage from './pages/CreateEditAgentPage';
import FileLibraryPage from './pages/FileLibraryPage';
import AdminPage from './pages/AdminPage';
import TranslatorPage from './pages/TranslatorPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<GalleryPage />} />
        <Route path="/agents/new" element={<CreateEditAgentPage />} />
        <Route path="/agents/:id" element={<AgentChatPage />} />
        <Route path="/agents/:id/edit" element={<CreateEditAgentPage />} />
        <Route path="/files" element={<FileLibraryPage />} />
        <Route path="/tools/translator" element={<TranslatorPage />} />
        <Route
          path="/admin"
          element={
            <ProtectedRoute adminOnly>
              <AdminPage />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
