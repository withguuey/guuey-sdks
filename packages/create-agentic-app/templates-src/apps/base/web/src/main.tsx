import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "@guuey/chat/styles.css";
import "./styles.css";
import { appConfig } from "./config";
import { BootstrapGate } from "./components/BootstrapGate";
import { Shell } from "./components/Shell";
import { Landing } from "./pages/Landing";
import { Login } from "./pages/Login";
import { Chat } from "./pages/Chat";
import { Home } from "./pages/Home";

// Site theme: one accent + light/dark, applied as CSS variables. The chat
// kit themes itself via its own tokens (see @guuey/chat theming docs).
document.documentElement.dataset.mode = appConfig.theme.mode;
document.documentElement.style.setProperty("--app-accent", appConfig.theme.accent);
document.title = appConfig.brand.name;

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/login", element: <Login /> },
      { path: "/chat", element: <Chat /> },
      { path: "/home", element: <Home /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BootstrapGate>
      <RouterProvider router={router} />
    </BootstrapGate>
  </StrictMode>,
);
