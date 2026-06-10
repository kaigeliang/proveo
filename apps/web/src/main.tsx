import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import SimpleApp from './simple/SimpleApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SimpleApp />
  </StrictMode>,
);
