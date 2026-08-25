# @guuey/agent-layout

**Agent-mode layout** — the layout category for surfaces where an app and its
agent share one screen: app menus in the upper sidebar, the agent rail below,
and a content pane whose ground **follows the user's attention** between the
two. Address the agent and the pane takes the agent's tone; navigate and it
returns to the app's. One law: _layout follows attention; transport owns the
stream_ — the tone flips on submit, never on stream events, and interrupting
is the transport's business.

```tsx
import {
  AgentModeProvider,
  AgentModeShell,
  AgentModeSidebar,
  SidebarPanel,
  ActivePane,
  bindGuueyChat,
  useAgentMode,
} from "@guuey/agent-layout/react";
import "@guuey/agent-layout/styles.css";

function Shell() {
  const { dispatch } = useAgentMode();
  return (
    <AgentModeShell>
      <AgentModeSidebar>
        <SidebarPanel section="app">{/* your menus — zero wiring */}</SidebarPanel>
        <SidebarPanel section="agent">
          <GuueyChat {...bindGuueyChat(dispatch)} />
        </SidebarPanel>
      </AgentModeSidebar>
      <ActivePane>{/* your routes / canvas */}</ActivePane>
    </AgentModeShell>
  );
}

<AgentModeProvider mode={mode} navigationKey={pathname} identity={<Logo />}>
  <Shell />
</AgentModeProvider>;
```

- **Two tones, calibrated**: the default pair is the founder-certified
  warm-paper/neutral-chrome step, light and dark. Overrides are validated
  against a perceptibility floor (ΔL\* ≥ 6, or a hue-temperature step) —
  two tones that measure alike are rejected with an explanation.
- **Route-derived follow**: pass your router's location key as
  `navigationKey`; every navigation returns the pane to the app tone with
  zero per-link wiring. Same-page menu clicks are caught by the app panel's
  capture-phase listener.
- **No stale-content hold**: while the agent has the room and nothing is
  presented yet, the pane shows a working state (your `identity` + pulse),
  never the previous page under the agent's tone.
- **Mode-aware**: pass the same `mode` you give your chat surface — the lib
  rides your existing light/dark machinery and adds none of its own.
- **Not a chat dependency**: `bindGuueyChat` pairs with `@guuey/chat`
  structurally; any agent surface can call the machine directly through
  `useAgentMode()`.

React DOM only, zero runtime dependencies, `react >= 18` peer.
