import { queryClient } from '@/utils/query-client';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { PostHogProvider } from 'posthog-js/react';
import { RouterProvider } from 'react-router-dom';

import { StatusBarThemeSync } from './components/status-bar-theme-sync';
import { Toaster } from './components/ui/sonner';
import { AuthConsumer, AuthProvider } from './contexts/auth';
import { ChatbotProvider } from './contexts/chatbot';
import router from './routes/sections';

function AppContent() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <ChatbotProvider>
          <AuthConsumer>
            <RouterProvider router={router} />
            <Toaster />
          </AuthConsumer>
        </ChatbotProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}

function App() {
  return (
    <PostHogProvider
      apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN}
      options={{ api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST }}
    >
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <StatusBarThemeSync />
        <AppContent />
      </ThemeProvider>
    </PostHogProvider>
  );
}

export default App;
