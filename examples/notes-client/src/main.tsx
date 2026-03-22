import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SyncClient, IdbLocalStore } from "@sync-subscribe/client";
import { SyncProvider } from "@sync-subscribe/client-react";
import { transport } from "./transport.js";
import { type NoteRecord, noteSchema } from "./types.js";
import App from "./App.js";

const localStore = new IdbLocalStore<NoteRecord>("notes");
const client = new SyncClient<NoteRecord>(transport, localStore, noteSchema);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SyncProvider client={client}>
      <App />
    </SyncProvider>
  </StrictMode>,
);
