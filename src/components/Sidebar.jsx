import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, MonitorPlay, BarChart3, AlertTriangle,
  Search, ChevronLeft, ChevronRight, Shield, Menu, Network, Flag, History, ScanLine
} from 'lucide-react';
import './Sidebar.css';

const navItems = [
  { path: '/dashboard', icon: LayoutDashboard, label: 'Overview' },
  { path: '/dashboard/live', icon: MonitorPlay, label: 'Live Monitoring' },
  { path: '/dashboard/analytics', icon: BarChart3, label: 'Analytics' },
  { path: '/dashboard/history', icon: History, label: 'Past Days' },
  { path: '/dashboard/alerts', icon: AlertTriangle, label: 'Alerts', badge: 'ACTIVE' },
  { path: '/dashboard/flagged', icon: Flag, label: 'Flagged Vehicles' },
  { path: '/dashboard/search', icon: Search, label: 'Vehicle Search' },
  { path: '/dashboard/superadmin', icon: Network, label: 'Superadmin' },
  { path: '/dashboard/ocr-test', icon: ScanLine, label: 'OCR Test' },
];

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <>
      <button className="sidebar-mobile-toggle" onClick={() => setCollapsed(!collapsed)}>
        <Menu size={18} />
      </button>
      <aside className={`tactical-sidebar ${collapsed ? 'tactical-sidebar--collapsed' : ''}`}>
        {/* Clean Application Brand Header */}
        <div className="tactical-sidebar__header">
          <div className="tactical-sidebar__node-box">
            <div className="tactical-sidebar__node-icon">
              <Shield size={16} />
            </div>
            {!collapsed && (
              <div className="tactical-sidebar__node-info">
                <span className="tactical-sidebar__node-title">VisionTrack ANPR</span>
                <span className="tactical-sidebar__node-sub">
                  <span className="tactical-ping-dot"></span> Surveillance Engine
                </span>
              </div>
            )}
          </div>
          <button
            className="tactical-sidebar__collapse-btn"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand Rail' : 'Collapse Rail'}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        {/* Navigation Rail */}
        <nav className="tactical-sidebar__nav">
          {navItems.map(item => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/dashboard'}
              className={({ isActive }) =>
                `tactical-nav-link ${isActive ? 'tactical-nav-link--active' : ''}`
              }
              title={collapsed ? item.label : undefined}
            >
              <item.icon size={16} className="tactical-nav-icon" />
              {!collapsed && <span className="tactical-nav-label">{item.label}</span>}
              {!collapsed && item.badge && (
                <span className="tactical-nav-badge">{item.badge}</span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Status Footer */}
        <div className="tactical-sidebar__footer">
          {!collapsed ? (
            <div className="tactical-heartbeat">
              <div className="tactical-heartbeat__status">
                <span className="tactical-ping-dot"></span>
                <span className="tactical-heartbeat__text">System Online</span>
              </div>
              <span className="tactical-heartbeat__uptime">Live Stream</span>
            </div>
          ) : (
            <div className="tactical-ping-dot tactical-ping-dot--center" title="System Online"></div>
          )}
        </div>
      </aside>
    </>
  );
}
