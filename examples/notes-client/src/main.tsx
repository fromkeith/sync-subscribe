import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SyncClient } from "@sync-subscribe/client";
import { SyncProvider } from "@sync-subscribe/client-react";
import { createTransport } from "./transport.js";
import type { NoteRecord } from "./types.js";
import App from "./App.js";

const client = new SyncClient<NoteRecord>(createTransport());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SyncProvider client={client}>
      <App />
    </SyncProvider>
  </StrictMode>
);
