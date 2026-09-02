// Repository provider — selects mock or real implementation based on config
import React, { createContext, useContext } from "react";
import { config } from "@/lib/config";
import type { AppRepositories } from "./interfaces";
import { mockRepositories } from "./mock";
import { realRepositories } from "./real";

const RepositoriesContext = createContext<AppRepositories>(
  config.mockMode ? mockRepositories : realRepositories
);

export function RepositoriesProvider({ children }: { children: React.ReactNode }) {
  const repos = config.mockMode ? mockRepositories : realRepositories;
  return (
    <RepositoriesContext.Provider value={repos}>
      {children}
    </RepositoriesContext.Provider>
  );
}

export function useRepositories(): AppRepositories {
  return useContext(RepositoriesContext);
}
