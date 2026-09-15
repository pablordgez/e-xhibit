import { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, Landmark } from 'lucide-react';
import { cloudConfigured, demo, supabase, invitationFlow } from './lib/storage';
const Editor = lazy(() => import('./components/Editor'));
const Visitor = lazy(() => import('./components/Visitor'));
export default function App() {
  const [path, setPath] = useState(location.pathname),
    [authenticated, setAuthenticated] = useState(demo),
    [checking, setChecking] = useState(cloudConfigured),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState('');
  const [needsPassword, setNeedsPassword] = useState(invitationFlow);
  useEffect(() => {
    const navigate = () => setPath(location.pathname);
    window.addEventListener('popstate', navigate);
    supabase?.auth.getSession().then(({ data }) => {
      setAuthenticated(Boolean(data.session));
      setChecking(false);
    });
    const subscription = supabase?.auth.onAuthStateChange((_, session) =>
      setAuthenticated(Boolean(session)),
    );
    return () => {
      window.removeEventListener('popstate', navigate);
      subscription?.data.subscription.unsubscribe();
    };
  }, []);
  function navigate(to: string) {
    history.pushState({}, '', to);
    setPath(to);
  }
  const editing = path === '/admin' || (path === '/' && demo);
  if (checking) return <div className="loading">Opening E-xhibit…</div>;
  if (authenticated && needsPassword)
    return (
      <main className="loading">
        <form
          className="password-setup"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await supabase!.auth.updateUser({ password });
            if (result.error) setError(result.error.message);
            else {
              setNeedsPassword(false);
              setPassword('');
            }
          }}
        >
          <span className="eyebrow">WELCOME TO YOUR STUDIO</span>
          <h1>Set your password.</h1>
          <label>
            New password
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="primary full">Save password and enter</button>
        </form>
      </main>
    );
  if (editing && !authenticated)
    return (
      <main className="login">
        <div className="login-art">
          <span className="brand">
            <Landmark /> e-xhibit<span className="brand-dot">®</span>
          </span>
          <p>
            Make space
            <br />
            <em>for art.</em>
          </p>
          <span>E-XHIBIT / EXHIBITION STUDIO</span>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            if (!supabase) {
              setError(
                'Admin authentication is not configured. Follow the deployment guide to connect Supabase.',
              );
              return;
            }
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) setError(error.message);
          }}
        >
          <span className="eyebrow">ADMINISTRATION</span>
          <h1>Sign in</h1>
          <p>Manage your museum and its collection.</p>
          <label>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="primary">
            Enter your studio <ArrowRight size={17} />
          </button>
          <button type="button" className="text-button" onClick={() => navigate('/visit')}>
            Just visiting? Explore the museum <ArrowUpRight size={15} />
          </button>
        </form>
      </main>
    );
  return (
    <Suspense fallback={<div className="loading">Preparing your space…</div>}>
      {editing ? (
        <Editor onVisit={() => navigate('/visit')} onSignOut={() => supabase?.auth.signOut()} />
      ) : (
        <Visitor onEdit={() => navigate('/admin')} />
      )}
    </Suspense>
  );
}
