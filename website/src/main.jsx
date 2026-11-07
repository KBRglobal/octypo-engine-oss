import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
const tree = (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
if (root.hasChildNodes()) hydrateRoot(root, tree);
else createRoot(root).render(tree);
