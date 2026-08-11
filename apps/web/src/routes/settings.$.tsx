import { createFileRoute, redirect } from "@tanstack/react-router";

import { settingsStationForPath } from "../components/settings/settingsStations";

export const Route = createFileRoute("/settings/$")({
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/kanban",
      search: { station: settingsStationForPath(location.pathname) },
      replace: true,
    });
  },
  component: () => null,
});
