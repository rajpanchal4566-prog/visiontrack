import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Search, User, ChevronDown, LogOut, Building2, Shield, Activity, Clock } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import './TopBar.css';

export default function TopBar({ title, alertCount = 0 }) {
  const { user, logout } = useAuth();
  const [showDropdown, setShowDropdown] = useState(false);
  const [utcTime, setUtcTime] = useState('');
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  // Live UTC Clock
  useEffect(() => {
    function updateClock() {
      const now = new Date();
      const hours = String(now.getUTCHours()).padStart(2, '0');
      const minutes = String(now.getUTCMinutes()).padStart(2, '0');
      const seconds = String(now.getUTCSeconds()).padStart(2, '0');
      setUtcTime(`UTC ${hours}:${minutes}:${seconds} SYNCED`);
    }
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleLogout() {
    setShowDropdown(false);
    logout();
    navigate('/login', { replace: true });
  }

  const displayName = user?.name || 'Operator';
  const displayRole = user?.role?.replace('_', ' ') || 'Tac-Operator';
  const orgName = user?.organization_name || '';

  return (
    <header className="tactical-topbar">
      {/* Left: System Brand & Active Title */}
      <div className="tactical-topbar__left">
        <div className="tactical-topbar__brand">
          <span className="tactical-diode tactical-diode--green"></span>
          <span className="tactical-topbar__callsign">VisionTrack</span>
        </div>
        <span className="tactical-topbar__divider">|</span>
        <h2 className="tactical-topbar__title">{title}</h2>
      </div>

      {/* Center: System Status */}
      <div className="tactical-topbar__center">
        <div className="tactical-telemetry-chip">
          <span className="tactical-diode tactical-diode--green animate-pulse"></span>
          <span className="tactical-telemetry-label">STATUS:</span>
          <span className="tactical-telemetry-val text-nominal">OPERATIONAL</span>
        </div>
        <div className="tactical-telemetry-chip">
          <span className="tactical-telemetry-label">ENGINE:</span>
          <span className="tactical-telemetry-val text-dim">LIVE INGESTION ACTIVE</span>
        </div>
      </div>

      {/* Right: Actions, Clock, Alerts & Profile */}
      <div className="tactical-topbar__right">
        {/* Quick Filter / Search */}
        <div className="tactical-search">
          <Search size={14} className="tactical-search__icon" />
          <input
            type="text"
            placeholder="Search plate or camera..."
            className="tactical-search__input"
          />
        </div>

        {/* Live UTC Clock */}
        <div className="tactical-clock">
          <Clock size={13} className="tactical-clock__icon" />
          <span className="tactical-clock__time font-mono">{utcTime || 'UTC SYNCED'}</span>
        </div>

        {/* Alerts Bell */}
        <button
          className="tactical-alert-btn"
          title="Tactical Security Alerts"
          onClick={() => navigate('/dashboard/alerts')}
        >
          <Bell size={16} />
          {alertCount > 0 && (
            <span className="tactical-alert-badge">{alertCount}</span>
          )}
        </button>

        {/* Operator Profile Dropdown */}
        <div className="tactical-user-wrapper" ref={dropdownRef}>
          <div
            className="tactical-user-trigger"
            onClick={() => setShowDropdown(!showDropdown)}
            title="Operator Bio-Auth Profile"
          >
            <div className="tactical-user-badge">
              {displayName.slice(0, 2).toUpperCase()}
            </div>
            <div className="tactical-user-info">
              <span className="tactical-user-name">{displayName}</span>
              <span className="tactical-user-role">{displayRole}</span>
            </div>
            <ChevronDown
              size={13}
              className={`tactical-user-arrow ${showDropdown ? 'tactical-user-arrow--open' : ''}`}
            />
          </div>

          {showDropdown && (
            <div className="tactical-user-dropdown">
              <div className="tactical-dropdown-header">
                <div className="tactical-dropdown-name">{displayName}</div>
                <div className="tactical-dropdown-email">{user?.email}</div>
                {orgName && (
                  <div className="tactical-dropdown-org">
                    <Building2 size={12} />
                    <span>{orgName}</span>
                  </div>
                )}
                <div className="tactical-dropdown-role-tag">{displayRole}</div>
              </div>
              <div className="tactical-dropdown-divider" />
              <button
                className="tactical-dropdown-item"
                onClick={() => { setShowDropdown(false); navigate('/dashboard/profile'); }}
              >
                <User size={14} />
                <span>Profile & Connection</span>
              </button>
              <button
                className="tactical-dropdown-item tactical-dropdown-item--logout"
                onClick={handleLogout}
              >
                <LogOut size={14} />
                <span>Operator Sign Out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
