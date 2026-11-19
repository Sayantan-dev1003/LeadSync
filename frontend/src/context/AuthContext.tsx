'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export interface AuthUser {
  email: string;
  name: string | null;
  picture: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authError: string | null;
  login: () => void;
  logout: () => Promise<void>;
  clearAuthError: () => void;
  refreshAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  authError: null,
  login: () => {},
  logout: async () => {},
  clearAuthError: () => {},
  refreshAuth: async () => {},
});

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_BACKEND_URL || '')
    : (process.env.BACKEND_PROXY_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000');

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/me`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          setUser(data.user);
          setIsAuthenticated(true);
        } else {
          setUser(null);
          setIsAuthenticated(false);
        }
      } else {
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch {
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Check for auth_error in query params
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const err = params.get('auth_error');
      if (err) {
        if (err === 'unauthorized') {
          setAuthError('This Google account is not authorized to manage LeadSync.');
        } else if (err === 'denied') {
          setAuthError('Google sign-in was cancelled.');
        } else if (err === 'invalid_state' || err === 'expired_state') {
          setAuthError('Authentication session expired. Please try signing in again.');
        } else if (err === 'email_not_verified') {
          setAuthError('Your Google email is not verified.');
        } else {
          setAuthError('Authentication failed. Please try again.');
        }

        // Clean query parameter from URL without page reload
        params.delete('auth_error');
        const newSearch = params.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '');
        window.history.replaceState({}, '', newUrl);
      }
    }

    refreshAuth();
  }, [refreshAuth]);

  const login = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.href = `${BACKEND_URL}/api/auth/google`;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch(`${BACKEND_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setUser(null);
      setIsAuthenticated(false);
      // Clean any cached CRM data in localStorage if present
      if (typeof window !== 'undefined') {
        localStorage.removeItem('leadsync_auth_token');
      }
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isLoading,
        authError,
        login,
        logout,
        clearAuthError,
        refreshAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
