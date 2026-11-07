import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import { getToken } from "./lib/api";
import { ToastProvider } from "./components/Toast";
import Shell from "./components/Shell";
import { Login } from "./pages/Login";
import Overview from "./pages/Overview";
import IdeaBank from "./pages/IdeaBank";
import Onboard from "./pages/Onboard";
import Facts from "./pages/Facts";
import StudioReview from "./pages/StudioReview";
import Schedule from "./pages/Schedule";
import Live from "./pages/Live";
import Settings from "./pages/Settings";
import Costs from "./pages/Costs";
import Seo from "./pages/Seo";
import { Articles } from "./pages/Articles";
import { Editor } from "./pages/Editor";
import { Feeds } from "./pages/Feeds";
import { Library } from "./pages/Library";

function RequireAuth({ children }: { children: ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter basename="/admin">
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <RequireAuth>
                <Shell />
              </RequireAuth>
            }
          >
            {/* The pipeline — the product's mental model, in order. */}
            <Route path="/" element={<Overview />} />
            <Route path="/ideas" element={<IdeaBank />} />
            <Route path="/onboard" element={<Onboard />} />
            <Route path="/facts" element={<Facts />} />
            <Route path="/review" element={<StudioReview />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/live" element={<Live />} />
            <Route path="/costs" element={<Costs />} />
            <Route path="/settings" element={<Settings />} />

            {/* Sources and tooling carried over from the previous console. */}
            <Route path="/articles" element={<Articles />} />
            <Route path="/articles/:id" element={<Editor />} />
            <Route path="/write" element={<Editor />} />
            <Route path="/feeds" element={<Feeds />} />
            <Route path="/library" element={<Library />} />

            {/* Optional research tools, on the operator's own provider credentials. */}
            <Route path="/seo" element={<Seo />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
