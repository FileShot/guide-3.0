/**
 * AccountPanel — License activation, OAuth sign-in, account management.
 * Three states: signed-in (activated), authenticated (free plan), sign-in form.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { UserCircle, Check, Shield, ExternalLink, LogOut, Key, Mail, Github, UserPlus } from 'lucide-react';

export default function AccountPanel() {
  const [licenseStatus, setLicenseStatus] = useState(null);
  const [tab, setTab] = useState('signin'); // 'signin' | 'key' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const oauthPollRef = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/license/status');
      const status = await res.json();
      if (status) setLicenseStatus(status);
    } catch (_) {}
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Cleanup OAuth poll on unmount
  useEffect(() => {
    return () => { if (oauthPollRef.current) clearInterval(oauthPollRef.current); };
  }, []);

  const showMessage = (msg, duration = 4000) => {
    setMessage(msg);
    if (duration > 0) setTimeout(() => setMessage(''), duration);
  };

  const handleOAuth = async (provider) => {
    setLoading(true);
    showMessage(`Opening ${provider === 'google' ? 'Google' : 'GitHub'} sign-in...`, 0);
    try {
      const res = await fetch('/api/license/oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const result = await res.json();
      if (result?.success && result?.url) {
        // Open OAuth URL in external browser
        if (window.electronAPI?.openExternal) {
          window.electronAPI.openExternal(result.url);
        } else {
          window.open(result.url, '_blank', 'noopener');
        }
        // Poll for authentication completion
        showMessage('Waiting for sign-in to complete...', 0);
        if (oauthPollRef.current) clearInterval(oauthPollRef.current);
        let attempts = 0;
        oauthPollRef.current = setInterval(async () => {
          attempts++;
          if (attempts > 60) { // 2min timeout
            clearInterval(oauthPollRef.current);
            oauthPollRef.current = null;
            setLoading(false);
            showMessage('Sign-in timed out. Please try again.');
            return;
          }
          try {
            const statusRes = await fetch('/api/account/status');
            const status = await statusRes.json();
            if (status?.isAuthenticated) {
              clearInterval(oauthPollRef.current);
              oauthPollRef.current = null;
              await loadStatus();
              setLoading(false);
              showMessage('Signed in successfully');
            }
          } catch (_) {}
        }, 2000);
      } else {
        showMessage(result?.error || 'Sign-in failed');
        setLoading(false);
      }
    } catch (e) {
      showMessage(e.message || 'Sign-in failed');
      setLoading(false);
    }
  };

  const handleEmailSignIn = async () => {
    if (!email.trim() || !password) return;
    setLoading(true);
    showMessage('Signing in...', 0);
    try {
      const res = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'account', email: email.trim(), password }),
      });
      const result = await res.json();
      if (result?.success) {
        setLicenseStatus({
          isActivated: true, isAuthenticated: true,
          license: result.license,
          machineId: licenseStatus?.machineId || '',
        });
        setEmail('');
        setPassword('');
        showMessage('Signed in successfully');
      } else {
        showMessage(result?.error || 'Sign in failed');
      }
    } catch (e) {
      showMessage(e.message || 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyActivation = async () => {
    if (!licenseKey.trim()) return;
    setLoading(true);
    showMessage('Activating...', 0);
    try {
      const res = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'key', key: licenseKey.trim() }),
      });
      const result = await res.json();
      if (result?.success) {
        setLicenseStatus({
          isActivated: true, isAuthenticated: true,
          license: result.license,
          machineId: licenseStatus?.machineId || '',
        });
        setLicenseKey('');
        showMessage('Activated successfully');
      } else {
        showMessage(result?.error || 'Activation failed');
      }
    } catch (e) {
      showMessage(e.message || 'Activation failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!email.trim() || !password) return;
    setLoading(true);
    showMessage('Creating account...', 0);
    try {
      const res = await fetch('/api/account/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, name: name.trim() || undefined }),
      });
      const result = await res.json();
      if (result?.success) {
        await loadStatus();
        setEmail('');
        setPassword('');
        setName('');
        showMessage('Account created successfully');
      } else {
        showMessage(result?.error || 'Registration failed');
      }
    } catch (e) {
      showMessage(e.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDeactivate = async () => {
    try {
      await fetch('/api/license/deactivate', { method: 'POST' });
      setLicenseStatus({
        isActivated: false, isAuthenticated: false,
        license: null, machineId: licenseStatus?.machineId || '',
      });
      showMessage('Signed out');
    } catch (e) {
      showMessage(e.message || 'Sign out failed');
    }
  };

  const openExternal = (url) => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  };

  // ── Signed in state (activated) ──
  if (licenseStatus?.isActivated) {
    return (
      <div className="flex flex-col h-full p-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full flex items-center justify-center bg-vsc-accent/90">
            <UserCircle size={24} className="text-vsc-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-medium truncate text-vsc-foreground">
              {licenseStatus.license?.email || 'Licensed User'}
            </p>
            <div className="flex items-center gap-1">
              <Check size={10} className="text-[#4ec9b0]" />
              <span className="text-[10px] text-[#4ec9b0]">License Active</span>
            </div>
          </div>
        </div>

        <div className="space-y-2 text-[11px] text-vsc-foreground/60">
          {licenseStatus.license?.plan && (
            <div className="flex justify-between">
              <span>Plan</span>
              <span className="capitalize text-vsc-foreground">{licenseStatus.license.plan}</span>
            </div>
          )}
          {licenseStatus.license?.key && (
            <div className="flex justify-between">
              <span>Key</span>
              <span className="font-mono text-[10px] text-vsc-foreground">{licenseStatus.license.key}</span>
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-vsc-panel-border">
          <button
            onClick={() => openExternal('https://graysoft.dev/account')}
            className="flex items-center gap-2 w-full px-3 py-2 text-[11px] rounded transition-colors hover:opacity-80 bg-vsc-sidebar-bg text-vsc-foreground"
          >
            <ExternalLink size={12} /> Manage Account
          </button>
        </div>

        <div className="mt-auto pt-4">
          <button
            onClick={handleDeactivate}
            className="flex items-center gap-2 text-[10px] text-[#f44747] hover:text-[#ff6b6b] transition-colors cursor-pointer"
          >
            <LogOut size={10} /> Sign Out
          </button>
        </div>

        {message && (
          <p className={`text-[10px] mt-2 ${message.includes('successfully') ? 'text-[#4ec9b0]' : 'text-[#f44747]'}`}>{message}</p>
        )}
      </div>
    );
  }

  // ── Authenticated but no license (free user) ──
  if (licenseStatus?.isAuthenticated && !licenseStatus?.isActivated) {
    return (
      <div className="flex flex-col h-full p-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full flex items-center justify-center bg-vsc-accent/90">
            <UserCircle size={24} className="text-vsc-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-medium truncate text-vsc-foreground">
              {licenseStatus.license?.email || 'Signed In'}
            </p>
            <div className="flex items-center gap-1">
              <Shield size={10} className="text-vsc-foreground/50" />
              <span className="text-[10px] capitalize text-vsc-foreground/50">
                {licenseStatus.license?.plan || 'Free'} Plan
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-2 text-[11px] mb-4 text-vsc-foreground/60">
          <div className="flex justify-between">
            <span>Status</span>
            <span className="text-vsc-foreground">Signed In</span>
          </div>
          <div className="flex justify-between">
            <span>Local AI</span>
            <span className="text-[#4ec9b0]">Included</span>
          </div>
          <div className="flex justify-between">
            <span>Cloud AI</span>
            <span className="text-vsc-foreground/50">Upgrade to unlock</span>
          </div>
        </div>

        <div className="p-3 rounded-md mb-3 bg-vsc-sidebar-bg border border-vsc-panel-border">
          <p className="text-[11px] font-medium mb-1 text-vsc-foreground">
            Upgrade to Pro
          </p>
          <p className="text-[10px] mb-2 text-vsc-foreground/60">
            Cloud AI models, web automation, unlimited conversations. $4.99/mo.
          </p>
          <button
            onClick={() => openExternal('https://graysoft.dev/account')}
            className="w-full px-3 py-2 text-[11px] font-medium rounded transition-colors hover:opacity-90 bg-vsc-accent text-white"
          >
            Get Pro
          </button>
        </div>

        <div className="pt-2 border-t border-vsc-panel-border">
          <button
            onClick={() => openExternal('https://graysoft.dev/account')}
            className="flex items-center gap-2 w-full px-3 py-2 text-[11px] rounded transition-colors hover:opacity-80 bg-vsc-sidebar-bg text-vsc-foreground"
          >
            <ExternalLink size={12} /> Manage Account
          </button>
        </div>

        <div className="mt-auto pt-4">
          <button
            onClick={handleDeactivate}
            className="flex items-center gap-2 text-[10px] text-[#f44747] hover:text-[#ff6b6b] transition-colors cursor-pointer"
          >
            <LogOut size={10} /> Sign Out
          </button>
        </div>

        {message && (
          <p className={`text-[10px] mt-2 ${message.includes('successfully') ? 'text-[#4ec9b0]' : 'text-[#f44747]'}`}>{message}</p>
        )}
      </div>
    );
  }

  // ── Sign in state ──
  return (
    <div className="flex flex-col h-full p-4">
      {/* Header */}
      <div className="text-center mb-5">
        <UserCircle size={36} className="mx-auto mb-2 text-vsc-foreground/50" />
        <p className="text-[12px] font-medium text-vsc-foreground">Sign in to guIDE</p>
        <p className="text-[10px] mt-1 text-vsc-foreground/50">
          Activate your license to unlock AI features
        </p>
      </div>

      {/* OAuth Buttons */}
      <div className="space-y-2 mb-3">
        <button
          onClick={() => handleOAuth('google')}
          disabled={loading}
          className="flex items-center justify-center gap-2 w-full px-3 py-2.5 text-[11px] font-medium rounded transition-all disabled:opacity-50 bg-vsc-sidebar-bg text-vsc-foreground border border-vsc-panel-border"
        >
          <svg width="14" height="14" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Continue with Google
        </button>
        <button
          onClick={() => handleOAuth('github')}
          disabled={loading}
          className="flex items-center justify-center gap-2 w-full px-3 py-2.5 text-[11px] font-medium rounded transition-all disabled:opacity-50 bg-vsc-sidebar-bg text-vsc-foreground border border-vsc-panel-border"
        >
          <Github size={14} />
          Continue with GitHub
        </button>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-2 my-2">
        <div className="flex-1 h-px bg-vsc-panel-border" />
        <span className="text-[9px] uppercase text-vsc-foreground/30">or</span>
        <div className="flex-1 h-px bg-vsc-panel-border" />
      </div>

      {/* Tab selector: Sign In / Register / License Key */}
      <div className="flex rounded overflow-hidden mb-2 border border-vsc-panel-border">
        <button
          onClick={() => setTab('signin')}
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-medium transition-colors"
          style={{
            backgroundColor: tab === 'signin' ? 'var(--vsc-accent, #007acc)' : 'transparent',
            color: tab === 'signin' ? '#fff' : undefined,
          }}
        >
          <Mail size={10} /> Sign In
        </button>
        <button
          onClick={() => setTab('register')}
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-medium transition-colors"
          style={{
            backgroundColor: tab === 'register' ? 'var(--vsc-accent, #007acc)' : 'transparent',
            color: tab === 'register' ? '#fff' : undefined,
          }}
        >
          <UserPlus size={10} /> Register
        </button>
        <button
          onClick={() => setTab('key')}
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-medium transition-colors"
          style={{
            backgroundColor: tab === 'key' ? 'var(--vsc-accent, #007acc)' : 'transparent',
            color: tab === 'key' ? '#fff' : undefined,
          }}
        >
          <Key size={10} /> Key
        </button>
      </div>

      {tab === 'signin' ? (
        <div className="space-y-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full rounded px-2.5 py-2 text-[11px] outline-none transition-colors bg-vsc-sidebar-bg border border-vsc-panel-border text-vsc-foreground"
            spellCheck={false}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded px-2.5 py-2 text-[11px] outline-none transition-colors bg-vsc-sidebar-bg border border-vsc-panel-border text-vsc-foreground"
            onKeyDown={(e) => e.key === 'Enter' && handleEmailSignIn()}
          />
          <button
            onClick={handleEmailSignIn}
            disabled={loading || !email.trim() || !password}
            className="w-full px-3 py-2 text-[11px] font-medium rounded transition-colors disabled:opacity-50 bg-vsc-accent text-white"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </div>
      ) : tab === 'register' ? (
        <div className="space-y-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            className="w-full rounded px-2.5 py-2 text-[11px] outline-none transition-colors bg-vsc-sidebar-bg border border-vsc-panel-border text-vsc-foreground"
            spellCheck={false}
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full rounded px-2.5 py-2 text-[11px] outline-none transition-colors bg-vsc-sidebar-bg border border-vsc-panel-border text-vsc-foreground"
            spellCheck={false}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded px-2.5 py-2 text-[11px] outline-none transition-colors bg-vsc-sidebar-bg border border-vsc-panel-border text-vsc-foreground"
            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
          />
          <button
            onClick={handleRegister}
            disabled={loading || !email.trim() || !password}
            className="w-full px-3 py-2 text-[11px] font-medium rounded transition-colors disabled:opacity-50 bg-vsc-accent text-white"
          >
            {loading ? 'Creating account...' : 'Create Account'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
            placeholder="GUIDE-XXXX-XXXX-XXXX-XXXX"
            className="w-full rounded px-2.5 py-2 text-[11px] font-mono outline-none transition-colors bg-vsc-sidebar-bg border border-vsc-panel-border text-vsc-foreground"
            spellCheck={false}
            onKeyDown={(e) => e.key === 'Enter' && handleKeyActivation()}
          />
          <button
            onClick={handleKeyActivation}
            disabled={loading || !licenseKey.trim()}
            className="w-full px-3 py-2 text-[11px] font-medium rounded transition-colors disabled:opacity-50 bg-vsc-accent text-white"
          >
            {loading ? 'Activating...' : 'Activate'}
          </button>
        </div>
      )}

      {/* Message */}
      {message && (
        <p className={`text-[10px] mt-2 ${message.includes('successfully') || message.includes('Signed') ? 'text-[#4ec9b0]' : message.includes('...') ? 'text-[#858585]' : 'text-[#f44747]'}`}>
          {message}
        </p>
      )}

      {/* Get a license link */}
      <div className="mt-auto pt-4">
        {tab !== 'register' ? (
          <button
            onClick={() => setTab('register')}
            className="text-[10px] transition-colors hover:underline text-vsc-accent"
          >
            Don't have an account? Create one
          </button>
        ) : (
          <button
            onClick={() => setTab('signin')}
            className="text-[10px] transition-colors hover:underline text-vsc-accent"
          >
            Already have an account? Sign in
          </button>
        )}
        <p className="text-[9px] mt-1.5 text-vsc-foreground/30">
          Free plan includes local AI. Pro $4.99/mo for cloud AI.
        </p>
      </div>
    </div>
  );
}
