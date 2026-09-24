import { createContext, useContext, useState, useEffect } from 'react';
import { authApi } from '../services/api';

const AuthContext = createContext(null);
const AUTH_REQUIRED = true;

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [connection, setConnection] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('anpr_token'));
  const [loading, setLoading] = useState(true);

  // On mount: validate stored token
  useEffect(() => {
    if (!AUTH_REQUIRED) {
      setLoading(false);
    } else if (token) {
      validateToken();
    } else {
      setLoading(false);
    }
  }, []);

  async function validateToken() {
    try {
      const data = await authApi.me();
      setUser(data.user);
      setConnection(data.connection || null);
    } catch (err) {
      // Token is invalid or expired
      console.warn('Session expired, clearing token');
      localStorage.removeItem('anpr_token');
      setToken(null);
      setUser(null);
      setConnection(null);
    } finally {
      setLoading(false);
    }
  }

  async function login(email, password) {
    const data = await authApi.login(email, password);
    localStorage.setItem('anpr_token', data.token);
    setToken(data.token);
    setUser(data.user);
    setConnection(data.connection || null);
    return data;
  }

  async function register(details) {
    const data = await authApi.register(details);
    localStorage.setItem('anpr_token', data.token);
    setToken(data.token);
    setUser(data.user);
    setConnection(data.connection || null);
    return data;
  }

  function logout() {
    localStorage.removeItem('anpr_token');
    setToken(null);
    setUser(null);
    setConnection(null);
  }

  const value = {
    user,
    connection,
    token,
    isAuthenticated: !!user,
    authRequired: AUTH_REQUIRED,
    loading,
    login,
    register,
    logout,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
