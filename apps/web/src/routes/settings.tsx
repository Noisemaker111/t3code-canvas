import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings is a station on the canvas, not a page of its own. This route (and
// the `settings.$` splat) exists only so old deep links keep landing — see
// settingsStations.ts. Never mount a settings shell here again; the kanban
// route owns the auth gate the redirect lands on.
export const Route = createFileRoute("/settings")({
  beforeLoad: ({ location }) => {
    if (location.pathname.replace(/\/+$/, "") === "/settings") {
      throw redirect({ to: "/kanban", search: { station: "settings" }, replace: true });
    }
  },
  component: () => null,
});
