import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../lib/api';

/* ---------------- toast ---------------- */
type Toast = { id: number; text: string; kind: 'ok' | 'bad' | 'info' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export const ToastHost: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, kind }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </ToastCtx.Provider>
  );
};

/* ---------------- small building blocks ---------------- */
export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="field">
    <label>{label}</label>
    {children}
    {hint ? <div className="hint">{hint}</div> : null}
  </div>
);

export const Tag: React.FC<{ children: React.ReactNode; kind?: 'ok' | 'warn' | 'bad' | 'accent' | '' }> = ({ children, kind = '' }) => (
  <span className={`tag ${kind}`}>{children}</span>
);

export const Banner: React.FC<{ kind: 'warn' | 'bad' | 'ok' | 'info'; children: React.ReactNode }> = ({ kind, children }) => (
  <div className={`banner ${kind}`}>{children}</div>
);

export const SeverityTag: React.FC<{ v: string }> = ({ v }) => {
  const kind = v === 'critical' ? 'bad' : v === 'warn' ? 'warn' : 'ok';
  return <Tag kind={kind}>{v.toUpperCase()}</Tag>;
};

/** Data is loaded once at app start and refreshed after every mutation. */
export const useData = () => {
  const [variants, setVariants] = useState<any>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const v = await api.variants();
      setVariants(v);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { variants, ready, error, reload };
};
