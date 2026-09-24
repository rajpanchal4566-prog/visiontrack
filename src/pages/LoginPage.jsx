import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Shield, Eye, EyeOff, Loader2, AlertCircle, ArrowLeft, LogIn } from 'lucide-react';
import './LoginPage.css';

export default function LoginPage() {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [city, setCity] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!email.trim() || !password.trim() || (mode === 'register' && (!name.trim() || !organizationName.trim() || !city.trim()))) {
      setError(mode === 'register' ? 'Complete all required fields' : 'Email and password are required');
      return;
    }

    setIsLoading(true);
    try {
      if (mode === 'register') {
        await register({ name, email, password, organization_name: organizationName, city });
      } else {
        await login(email.trim(), password);
      }
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.message || 'Invalid email or password');
    } finally {
      setIsLoading(false);
    }
  }

  function handleBack() {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/');
    }
  }

  return (
    <div className="tactical-login-page">
      {/* Background Ambience */}
      <div className="tactical-login-bg">
        <div className="tactical-login-grid" />
        <div className="tactical-login-scanline" />
      </div>

      {/* Center Tactical Auth Box */}
      <div className="tactical-auth-card tactical-border-cross hud-box-cyan">
        {/* Top Hairline Signal Line */}
        <div className="tactical-auth-hairline"></div>

        {/* Reticle Corner Brackets */}
        <div className="reticle-corner -top-1 -left-1 border-t-2 border-l-2"></div>
        <div className="reticle-corner -top-1 -right-1 border-t-2 border-r-2"></div>
        <div className="reticle-corner -bottom-1 -left-1 border-b-2 border-l-2"></div>
        <div className="reticle-corner -bottom-1 -right-1 border-b-2 border-r-2"></div>

        {/* Back Button */}
        <div className="tactical-card-top-nav">
          <button
            type="button"
            className="tactical-back-btn font-mono"
            onClick={handleBack}
            title="Return to previous page"
          >
            <ArrowLeft size={14} />
            <span>BACK</span>
          </button>
        </div>

        {/* Minimal Portal Header */}
        <div className="tactical-auth-header">
          <div className="tactical-auth-seal">
            <Shield size={24} className="text-cyan" />
          </div>
          <h1 className="tactical-auth-title font-display">
            {mode === 'register' ? 'CREATE ACCOUNT' : 'SIGN IN'}
          </h1>
          <p className="tactical-auth-subtitle font-mono">
            {mode === 'register' ? 'Register your organization' : 'VisionTrack Traffic Intelligence'}
          </p>
        </div>

        {/* Error Alert Box */}
        {error && (
          <div className="tactical-auth-error font-mono">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        {/* Form */}
        <form className="tactical-auth-form" onSubmit={handleSubmit}>
          {mode === 'register' && (
            <>
              <div className="tactical-field">
                <label className="tactical-field-label font-mono">NAME</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="tactical-field-input"
                  placeholder="Your full name"
                  disabled={isLoading}
                />
              </div>
              <div className="tactical-field">
                <label className="tactical-field-label font-mono">ORGANIZATION</label>
                <input
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  className="tactical-field-input"
                  placeholder="Department or company name"
                  disabled={isLoading}
                />
              </div>
              <div className="tactical-field">
                <label className="tactical-field-label font-mono">CITY</label>
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className="tactical-field-input"
                  placeholder="e.g. Hyderabad"
                  disabled={isLoading}
                />
              </div>
            </>
          )}

          <div className="tactical-field">
            <label className="tactical-field-label font-mono">EMAIL</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="tactical-field-input font-mono"
              placeholder="name@organization.com"
              autoComplete="email"
              disabled={isLoading}
            />
          </div>

          <div className="tactical-field">
            <label className="tactical-field-label font-mono">PASSWORD</label>
            <div className="tactical-input-action-wrapper">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="tactical-field-input font-mono"
                placeholder="••••••••••••"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                disabled={isLoading}
              />
              <button
                type="button"
                className="tactical-eye-btn"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary tactical-auth-submit hud-glow-cyan font-mono"
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>{mode === 'register' ? 'CREATING ACCOUNT...' : 'SIGNING IN...'}</span>
              </>
            ) : (
              <>
                <LogIn size={15} />
                <span>{mode === 'register' ? 'CREATE ACCOUNT' : 'SIGN IN'}</span>
              </>
            )}
          </button>
        </form>

        {/* Quick Demo Operator Shortcut */}
        {mode === 'login' && (
          <div className="tactical-demo-box">
            <span className="font-mono text-xs text-outline">DEMO ACCOUNTS:</span>
            <div className="tactical-demo-btns font-mono">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => { setEmail('admin@visiontrack.ai'); setPassword('Admin@123'); }}
              >
                ADMIN
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => { setEmail('operator@citypolice.gov'); setPassword('Operator@123'); }}
              >
                POLICE OPERATOR
              </button>
            </div>
          </div>
        )}

        {/* Mode Switcher */}
        <div className="tactical-auth-footer font-mono">
          {mode === 'login' ? (
            <span>
              Don't have an account?{' '}
              <button type="button" className="text-cyan font-bold" onClick={() => { setMode('register'); setError(''); }}>
                Create Account
              </button>
            </span>
          ) : (
            <span>
              Already have an account?{' '}
              <button type="button" className="text-cyan font-bold" onClick={() => { setMode('login'); setError(''); }}>
                Sign In
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
