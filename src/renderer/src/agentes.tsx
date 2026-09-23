// Entry standalone /agentes (spec v1.2): solo MisAgentes + token gate.
// No importa App.tsx ni nada que toque window.cth.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MisAgentes } from '@/views/MisAgentes';

const TOKEN_KEY = 'cth.token';

function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [hint, setHint] = useState('');
  const save = (): void => {
    const t = value.replace(/\s+/g, '');
    if (!t) {
      setHint('Pega el WEB_TOKEN (sin espacios).');
      return;
    }
    try {
      window.sessionStorage.setItem(TOKEN_KEY, t);
    } catch { /* sin storage: sigue en memoria de la pestaña */ }
    onSaved();
  };
  return (
    <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', maxWidth: 420 }}>
      <h1 style={{ fontSize: 18 }}>Mis agentes</h1>
      <p>Pega el WEB_TOKEN del servidor para conectar por la tailnet.</p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        placeholder="WEB_TOKEN"
        autoComplete="off"
        style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
      />
      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={save}>Conectar</button>
        {hint ? <p role="alert">{hint}</p> : null}
      </div>
    </div>
  );
}

function AgentesBoot() {
  const [authed, setAuthed] = useState(() => {
    try {
      return !!(window.sessionStorage.getItem(TOKEN_KEY) ?? '').trim();
    } catch {
      return false;
    }
  });
  if (!authed) return <TokenGate onSaved={() => setAuthed(true)} />;
  return <MisAgentes />;
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AgentesBoot />
    </StrictMode>
  );
}
