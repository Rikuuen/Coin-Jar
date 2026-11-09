import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/fraunces/400.css';
import '@fontsource/fraunces/400-italic.css';
import './styles.css';
const app = import.meta.env.VITE_COINJAR_PHONE === 'true'
  ? import('./PhoneApp')
  : import.meta.env.VITE_COINJAR_HOSTED === 'true'
  ? import('./HostedApp')
  : new URLSearchParams(window.location.search).get('advanced') === '1'
    ? import('./App')
    : import('./SimpleApp');
void app.then(({ default: Component }) => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><Component /></React.StrictMode>);
});
