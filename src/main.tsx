import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/fraunces/400.css';
import '@fontsource/fraunces/400-italic.css';
import App from './App';
import SimpleApp from './SimpleApp';
import './styles.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('advanced') === '1' ? <App /> : <SimpleApp />}
  </React.StrictMode>,
);
