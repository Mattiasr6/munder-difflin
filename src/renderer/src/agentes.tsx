// Entry standalone /agentes (spec v1.2): solo MisAgentes + token gate.
// No importa App.tsx ni nada que toque window.cth.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { consumeUrlToken } from '@/api/cthClient';
import { MisAgentes } from '@/views/MisAgentes';

consumeUrlToken();

const TOKEN_KEY = 'cth.token';

function TokenGate({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [hint, setHint] = useState('');
  const save = (): void => {
    const token = value.replace(/\s+/g, '');
    if (!token) {
      setHint(t('web.tokenHint'));
      return;
    }
    try {
      window.sessionStorage.setItem(TOKEN_KEY, token);
    } catch { /* sin storage: sigue en memoria de la pestaña */ }
    onSaved();
  };
  return (
    <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', maxWidth: 420 }}>
      <h1 style={{ fontSize: 18 }}>{t('web.title')}</h1>
      <p>{t('web.tokenPrompt')}</p>
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
        <button type="button" onClick={save}>{t('web.connect')}</button>
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
