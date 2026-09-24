import React, { createContext, useContext, useEffect, useState } from "react";
import { api, normalizeModel, sortModels } from "./lib.js";
import { models as fallbackModels } from "./data.js";
const Context = createContext(null);
export const useApp = () => useContext(Context);
// Where "get started" links lead: the real workspace when signed in,
// otherwise account creation, which opens the workspace afterwards.
export function useStartPath() {
  const app = useContext(Context);
  return (path = "/workspace") => (app?.user ? path : "/register");
}
export function AppProvider({ children }) {
  const [config, setConfig] = useState(null),
    [models, setModels] = useState(fallbackModels),
    [user, setUser] = useState(null),
    [connected, setConnected] = useState(false),
    [loading, setLoading] = useState(true),
    [catalogMeta, setCatalogMeta] = useState({
      source: "Illustrative catalog from product brief",
      live: false,
    });
  // Config, catalog and session load independently: a catalog failure keeps a valid
  // session, and only a failed /api/me clears the signed-in user.
  async function refresh() {
    const [c, m, u] = await Promise.allSettled([
      api("/api/config"),
      api("/api/models"),
      api("/api/me"),
    ]);
    if (c.status === "fulfilled") {
      setConfig(c.value);
      setConnected(true);
    } else {
      setConfig(null);
      setConnected(false);
    }
    if (m.status === "fulfilled" && Array.isArray(m.value.data)) {
      setModels(sortModels(m.value.data.map(normalizeModel)));
      const { data, ...meta } = m.value;
      setCatalogMeta({ ...meta, connected: true });
    }
    setUser(u.status === "fulfilled" ? u.value.user : null);
    setLoading(false);
  }
  useEffect(() => {
    refresh();
  }, []);
  return (
    <Context.Provider
      value={{
        config,
        models,
        user,
        setUser,
        connected,
        loading,
        refresh,
        catalogMeta,
      }}
    >
      {children}
    </Context.Provider>
  );
}
