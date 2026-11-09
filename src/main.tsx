import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/fraunces/400.css';
import '@fontsource/fraunces/400-italic.css';
import './styles.css';
const root = createRoot(document.getElementById('root')!);
if (import.meta.env.VITE_COINJAR_PHONE === 'true') {
  const url = new URL(window.location.href);
  if (url.searchParams.has('walrus')) { url.searchParams.delete('walrus'); window.history.replaceState(null, '', url); }
  void import('./phoneNetwork').then(async ({ needsJournalChoice, chooseJournalSpace }) => {
    if (needsJournalChoice) {
      await import('./simple.css');
      root.render(<main className="simple-main"><h1>Choose your journal</h1><p>Two journals were saved in this browser. Choose which one to open. Neither journal will be deleted.</p><button className="simple-button primary" onClick={() => chooseJournalSpace('legacy')}>Open journal from the longer link</button><button className="simple-button outline" onClick={() => chooseJournalSpace('regular')}>Open journal from the plain link</button></main>);
      return;
    }
    const { default: Component } = await import('./PhoneApp');
    root.render(<React.StrictMode><Component /></React.StrictMode>);
  });
} else {
  const app = import.meta.env.VITE_COINJAR_HOSTED === 'true'
  ? import('./HostedApp')
  : new URLSearchParams(window.location.search).get('advanced') === '1'
    ? import('./App')
    : import('./SimpleApp');
void app.then(({ default: Component }) => {
  root.render(<React.StrictMode><Component /></React.StrictMode>);
});
}
