import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import LandingPage from './pages/LandingPage';
import DashboardLayout from './layouts/DashboardLayout';
import Overview from './pages/dashboard/Overview';
import LiveMonitoring from './pages/dashboard/LiveMonitoring';
import Analytics from './pages/dashboard/Analytics';
import PastDays from './pages/dashboard/PastDays';
import Alerts from './pages/dashboard/Alerts';
import VehicleSearch from './pages/dashboard/VehicleSearch';
import SystemHealth from './pages/dashboard/SystemHealth';
import ProfilePage from './pages/ProfilePage';
import CameraNetwork from './pages/dashboard/CameraNetwork';
import FlaggedVehicles from './pages/dashboard/FlaggedVehicles';
import Network from './pages/dashboard/Network';
import OcrTest from './pages/dashboard/OcrTest';

function AppRoutes() {
  const { isAuthenticated, loading } = useAuth();

  return (
    <Routes>
      {/* Login remains available when VITE_AUTH_REQUIRED=true. */}
      <Route path="/login" element={
        !loading && isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />
      } />

      {/* Landing Page */}
      <Route path="/" element={<LandingPage />} />

      {/* Dashboard Routes — Protected */}
      <Route path="/dashboard" element={
        <ProtectedRoute>
          <DashboardLayout />
        </ProtectedRoute>
      }>
        <Route index element={<Overview />} />
        <Route path="live" element={<LiveMonitoring />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="history" element={<PastDays />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="flagged" element={<FlaggedVehicles />} />
        <Route path="search" element={<VehicleSearch />} />
        <Route path="superadmin" element={<Network />} />
        <Route path="network-settings" element={<Network />} />
        <Route path="health" element={<Navigate to="/dashboard" replace />} />
        <Route path="network" element={<Navigate to="/dashboard" replace />} />
        <Route path="ocr-test" element={<OcrTest />} />
        <Route path="profile" element={<ProfilePage />} />
      </Route>

      {/* Catch-all redirect */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
