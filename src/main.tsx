import { createRoot } from "react-dom/client";
import App from "./App";
import "./app.css";

// No StrictMode: its double-mounted effects would spawn two PTYs per pane.
createRoot(document.getElementById("root")!).render(<App />);
