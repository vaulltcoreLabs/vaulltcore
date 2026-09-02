// Centralized environment configuration
// Do not hardcode values here — read from Vite env

export const config = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || "http://localhost:3000",
  mockMode: import.meta.env.VITE_MOCK_MODE === "true",
  appName: "Vaulltcore",
  appTagline: "AI Engineering Automation",
} as const;

export type AppConfig = typeof config;
