import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { BattlefieldApp } from './components/BattlefieldApp';
import './index.css';

const isBattlefieldEntry =
  document.documentElement.dataset.appMode === 'battlefield' ||
  window.location.pathname.endsWith('battlefield.html') ||
  new URLSearchParams(window.location.search).get('app') === 'battlefield';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isBattlefieldEntry ? <BattlefieldApp /> : <App />}
  </React.StrictMode>
);
