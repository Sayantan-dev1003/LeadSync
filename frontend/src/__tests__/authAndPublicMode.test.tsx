import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Navbar } from '../components/Navbar';
import { RecentImports } from '../components/RecentImports';
import ManageLeadsPage from '../app/manage-leads/page';
import { CSVImporter } from '../components/CSVImporter';
import * as AuthContextModule from '../context/AuthContext';

// Mock next/navigation
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

// Mock API module
jest.mock('../lib/api', () => ({
  extractLeads: jest.fn(),
  approvePendingImport: jest.fn(),
  rejectPendingImport: jest.fn(),
  getPendingImport: jest.fn(),
  getAuthHeaders: () => ({}),
}));

describe('Phase 3 & Phase 6: Authentication & Public Empty Read-Only Mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  describe('Navbar Component', () => {
    it('renders "Sign in with Google" button and "Public Read-Only" badge when unauthenticated', () => {
      const mockLogin = jest.fn();
      jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        authError: null,
        login: mockLogin,
        logout: jest.fn(),
        clearAuthError: jest.fn(),
        refreshAuth: jest.fn(),
      });

      render(<Navbar />);

      expect(screen.getByText('LeadSync')).toBeInTheDocument();
      expect(screen.getByText('Public Read-Only')).toBeInTheDocument();

      const signInBtn = screen.getByTestId('google-signin-button');
      expect(signInBtn).toBeInTheDocument();
      expect(signInBtn).toHaveTextContent(/Sign in with Google/i);

      fireEvent.click(signInBtn);
      expect(mockLogin).toHaveBeenCalledTimes(1);
    });

    it('displays loading skeleton while authentication is unresolved', () => {
      jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
        user: null,
        isAuthenticated: false,
        isLoading: true,
        authError: null,
        login: jest.fn(),
        logout: jest.fn(),
        clearAuthError: jest.fn(),
        refreshAuth: jest.fn(),
      });

      render(<Navbar />);

      expect(screen.getByTestId('auth-loading')).toBeInTheDocument();
      expect(screen.queryByTestId('google-signin-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('owner-profile-button')).not.toBeInTheDocument();
    });

    it('renders owner profile and "Owner Mode" badge when authenticated, and allows logout', async () => {
      const mockLogout = jest.fn();
      jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
        user: {
          email: 'owner@leadsync.com',
          name: 'LeadSync Owner',
          picture: 'https://example.com/owner.jpg',
        },
        isAuthenticated: true,
        isLoading: false,
        authError: null,
        login: jest.fn(),
        logout: mockLogout,
        clearAuthError: jest.fn(),
        refreshAuth: jest.fn(),
      });

      render(<Navbar />);

      expect(screen.getByText('Owner Mode')).toBeInTheDocument();
      expect(screen.queryByTestId('google-signin-button')).not.toBeInTheDocument();

      const profileBtn = screen.getByTestId('owner-profile-button');
      expect(profileBtn).toBeInTheDocument();
      expect(screen.getByText('LeadSync Owner')).toBeInTheDocument();

      // Open profile dropdown
      fireEvent.click(profileBtn);
      expect(screen.getByTestId('owner-dropdown-menu')).toBeInTheDocument();
      expect(screen.getByText('owner@leadsync.com')).toBeInTheDocument();

      // Click Logout
      const logoutBtn = screen.getByTestId('logout-button');
      fireEvent.click(logoutBtn);
      expect(mockLogout).toHaveBeenCalledTimes(1);
    });

    it('displays alert banner when authError is present and clears on dismissal', () => {
      const mockClear = jest.fn();
      jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        authError: 'This Google account is not authorized to manage LeadSync.',
        login: jest.fn(),
        logout: jest.fn(),
        clearAuthError: mockClear,
        refreshAuth: jest.fn(),
      });

      render(<Navbar />);

      expect(screen.getByRole('alert')).toHaveTextContent(
        'This Google account is not authorized to manage LeadSync.'
      );

      const dismissBtn = screen.getByLabelText(/dismiss alert/i);
      fireEvent.click(dismissBtn);
      expect(mockClear).toHaveBeenCalledTimes(1);
    });
  });

  describe('Public Read-Only Mode: RecentImports Component', () => {
    it('shows zero imports and empty state message in public unauthenticated mode without querying API', () => {
      jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        authError: null,
        login: jest.fn(),
        logout: jest.fn(),
        clearAuthError: jest.fn(),
        refreshAuth: jest.fn(),
      });

      render(<RecentImports />);

      expect(screen.getByTestId('public-recent-imports')).toBeInTheDocument();
      expect(screen.getByText('Public Read-Only Mode')).toBeInTheDocument();
      expect(
        screen.getByText(/Zero recent imports. Real CRM imports and historical records are private/i)
      ).toBeInTheDocument();

      // Ensure fetch was NEVER called to query private records
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('queries and displays real imports when owner is authenticated', async () => {
      jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
        user: { email: 'owner@example.com', name: 'Owner', picture: null },
        isAuthenticated: true,
        isLoading: false,
        authError: null,
        login: jest.fn(),
        logout: jest.fn(),
        clearAuthError: jest.fn(),
        refreshAuth: jest.fn(),
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          imports: [
            {
              id: 'imp_123',
              filename: 'q4_leads.csv',
              totalRows: 150,
              totalImported: 140,
              totalSkipped: 10,
              createdAt: '2026-11-19T00:00:00.000Z',
            },
          ],
        }),
      });

      render(<RecentImports />);

      await waitFor(() => {
        expect(screen.getByTestId('owner-recent-imports')).toBeInTheDocument();
        expect(screen.getByText('q4_leads.csv')).toBeInTheDocument();
        expect(screen.getByText('140 leads imported')).toBeInTheDocument();
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/imports'),
        expect.objectContaining({ credentials: 'include' })
      );
    });
  });

  describe('Public Read-Only Mode: Manage Leads Page', () => {
    it('displays empty table and disables search in public unauthenticated mode without calling /api/leads', () => {
      jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        authError: null,
        login: jest.fn(),
        logout: jest.fn(),
        clearAuthError: jest.fn(),
        refreshAuth: jest.fn(),
      });

      render(<ManageLeadsPage />);

      expect(screen.getByTestId('leads-table')).toBeInTheDocument();
      expect(screen.getByTestId('public-empty-leads')).toBeInTheDocument();
      expect(screen.getByText(/Zero leads displayed. All CRM data is private to the authenticated owner/i)).toBeInTheDocument();

      // Search input is disabled for public unauthenticated visitors
      const searchInput = screen.getByPlaceholderText(/Sign in to search leads.../i);
      expect(searchInput).toBeDisabled();

      // Zero backend calls made
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('queries and renders real leads when authenticated owner opens Manage Leads', async () => {
      jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
        user: { email: 'owner@example.com', name: 'Owner', picture: null },
        isAuthenticated: true,
        isLoading: false,
        authError: null,
        login: jest.fn(),
        logout: jest.fn(),
        clearAuthError: jest.fn(),
        refreshAuth: jest.fn(),
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          leads: [
            {
              id: 'lead_abc',
              name: 'Alice Johnson',
              email: 'alice@company.com',
              mobileWithoutCountryCode: '9876543210',
              countryCode: '1',
              createdAt: '2026-11-19T00:00:00.000Z',
              importedAt: '2026-11-19T00:00:00.000Z',
              company: 'Alice Enterprises',
              crmStatus: 'Sale Done',
            },
          ],
        }),
      });

      render(<ManageLeadsPage />);

      await waitFor(() => {
        expect(screen.getByText('Alice Johnson')).toBeInTheDocument();
        expect(screen.getByText('alice@company.com')).toBeInTheDocument();
        expect(screen.getByText('Alice Enterprises')).toBeInTheDocument();
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/leads'),
        expect.objectContaining({ credentials: 'include' })
      );
    });
  });

  describe('Public Mode: CSVImporter Component', () => {
    it('shows owner sign-in required notice when unauthenticated visitor clicks Import Leads', () => {
      const mockLogin = jest.fn();
      jest.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        authError: null,
        login: mockLogin,
        logout: jest.fn(),
        clearAuthError: jest.fn(),
        refreshAuth: jest.fn(),
      });

      // Temporarily override NODE_ENV to production simulation
      const prevEnv = process.env.NODE_ENV;
      (process.env as any).NODE_ENV = 'production';

      try {
        render(<CSVImporter />);

        const triggerBtn = screen.getByRole('button', { name: /import leads/i });
        fireEvent.click(triggerBtn);

        expect(screen.getByTestId('auth-required-dialog')).toBeInTheDocument();
        expect(
          screen.getByText('Sign in with Google to Import Leads')
        ).toBeInTheDocument();
        expect(
          screen.getByText(/CSV uploads, Gemini AI parsing, and CRM mutations are restricted to the verified single owner/i)
        ).toBeInTheDocument();

        // Clicking the sign-in button triggers Google OAuth
        const signInBtn = screen.getByRole('button', { name: /sign in with google as owner/i });
        fireEvent.click(signInBtn);
        expect(mockLogin).toHaveBeenCalledTimes(1);

        // Upload dropzone is NOT rendered
        expect(screen.queryByTestId('upload-step')).not.toBeInTheDocument();
      } finally {
        (process.env as any).NODE_ENV = prevEnv;
      }
    });
  });
});
