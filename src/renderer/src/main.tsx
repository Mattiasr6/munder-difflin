import { installWebCth } from './api/webCth';
import { consumeUrlToken } from './api/cthClient';
installWebCth();
consumeUrlToken();
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import brandLogo from '@brand/logo.png?url';
import './design/global.css';
import './i18n';

const favicon = document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/png';
favicon.href = brandLogo;
document.head.appendChild(favicon);

const splashMark = document.querySelector('#cth-splash .mk');
if (splashMark) {
  const img = document.createElement('img');
  img.src = brandLogo;
  img.alt = 'Munder Difflin';
  img.style.cssText = 'height:56px;width:auto;display:block';
  splashMark.replaceWith(img);
}

const root = document.getElementById('root');
if (!root) throw new Error('No root element');

function hasToken(): boolean {
  try {
    return !!((window as unknown as { cth?: { version?: string } }).cth?.version && window.sessionStorage.getItem('cth.token')?.trim());
  } catch {
    return true;
  }
}

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
      window.sessionStorage.setItem('cth.token', t);
    } catch { /* sin storage: no se puede operar */ }
    onSaved();
  };
  return (
    <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', maxWidth: 420 }}>
      <h1 style={{ fontSize: 18 }}>Munder Difflin — tailnet</h1>
      <p>Pega el WEB_TOKEN del servidor para entrar a la oficina.</p>
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
        <button type="button" onClick={save}>Entrar</button>
        {hint ? <p role="alert">{hint}</p> : null}
      </div>
    </div>
  );
}

function Boot() {
  // En Electron window.cth lo pone el preload (con todo) y no hay token gate.
  const isWeb = (window as unknown as { cth?: { version?: string } }).cth?.version === 'web';
  const [authed, setAuthed] = useState(() => !isWeb || hasToken());
  if (!authed) return <TokenGate onSaved={() => setAuthed(true)} />;
  return <App />;
}

createRoot(root).render(
  <StrictMode>
    <Boot />
  </StrictMode>
);
