import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './main';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 250, refetchOnWindowFocus: false } } });

console.log('[PP-DIAG] main-entry root render', {
  settings: null,
  base: null,
  queryKey: 'app-root',
  path: typeof location === 'undefined' ? '/' : location.pathname,
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
