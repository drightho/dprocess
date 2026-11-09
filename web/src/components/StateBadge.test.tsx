import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import StateBadge from "./StateBadge";

const css = readFileSync("src/styles.css", "utf8");

describe("StateBadge for ready_for_testing", () => {
  it("shows the raw state value", () => {
    const { container } = render(<StateBadge state="ready_for_testing" />);
    const badge = container.querySelector(".badge.state")!;
    expect(badge.getAttribute("data-state")).toBe("ready_for_testing");
    expect(badge.textContent).toBe("ready_for_testing");
  });

  it("has a colour rule and a colour token in the light and the dark theme", () => {
    expect(css).toContain('.badge.state[data-state="ready_for_testing"] { --st: var(--st-ready-for-testing); }');
    const dark = css.indexOf("@media (prefers-color-scheme: dark)");
    expect(dark).toBeGreaterThan(0);
    const token = /--st-ready-for-testing:\s*#[0-9a-fA-F]{6};/;
    expect(token.test(css.slice(0, dark))).toBe(true); // light block
    // Depends on the stylesheet formatting: the dark block ends at the first "}\n}".
    const darkBlock = css.slice(dark, css.indexOf("}\n}", dark));
    expect(token.test(darkBlock)).toBe(true);
  });
});
