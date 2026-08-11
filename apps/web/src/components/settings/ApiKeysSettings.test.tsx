import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ApiKeysSettingsPanel } from "./ApiKeysSettings";

describe("ApiKeysSettingsPanel", () => {
  const markup = renderToStaticMarkup(<ApiKeysSettingsPanel embedded />);

  it("renders one labelled key field per family", () => {
    for (const title of ["OpenRouter", "Grok (xAI)", "Cursor"]) {
      expect(markup).toContain(`aria-label="${title} API key"`);
      expect(markup).toContain(`aria-label="Save ${title} API key"`);
    }
    expect(markup).toContain("API keys");
  });

  it("masks every key input", () => {
    expect(markup.match(/type="password"/g)).toHaveLength(3);
    expect(markup).not.toContain('type="text"');
  });

  it("says what the OpenRouter key drives, so it is not read as usage-only", () => {
    expect(markup).toContain("Hermes");
    expect(markup).toContain("OpenCode runs");
  });
});
