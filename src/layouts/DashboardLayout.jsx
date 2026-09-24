import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import TopBar from '../components/TopBar';
import { onNewAlert } from '../services/socket';
import './DashboardLayout.css';

function playSosTone() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(880, context.currentTime);
  oscillator.frequency.setValueAtTime(660, context.currentTime + 0.18);
  oscillator.frequency.setValueAtTime(880, context.currentTime + 0.36);
  gain.gain.setValueAtTime(0.08, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.55);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.55);
  oscillator.addEventListener('ended', () => context.close());
}

const pageTitles = {
  '/dashboard': 'Overview',
  '/dashboard/live': 'Live Monitoring',
  '/dashboard/analytics': 'Analytics',
  '/dashboard/history': 'Past Days',
  '/dashboard/alerts': 'Alerts',
  '/dashboard/flagged': 'Flagged Vehicles',
  '/dashboard/search': 'Vehicle Search',
  '/dashboard/superadmin': 'Superadmin',
  '/dashboard/network-settings': 'Superadmin',
  '/dashboard/ocr-test': 'OCR Test',
  '/dashboard/profile': 'Profile',
};

export default function DashboardLayout() {
  const location = useLocation();
  const title = pageTitles[location.pathname] || 'Dashboard';

  useEffect(() => onNewAlert(playSosTone), []);

  return (
    <div className="dashboard-layout">
      <div className="grid-bg"></div>
      <Sidebar />
      <div className="dashboard-layout__main">
        <TopBar title={title} />
        <main className="dashboard-layout__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
