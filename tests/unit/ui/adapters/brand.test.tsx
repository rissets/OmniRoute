// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import OmniRouteLogo, { OmniRouteLockup } from "@/shared/components/OmniRouteLogo";
afterEach(cleanup);
describe("BP Batam brand wrappers", () => {
  it("preserves emblem dimensions and the official asset", () => {
    render(<OmniRouteLogo size={22} className="x" />);
    const img = screen.getByRole("img", { name: "BP Batam" });
    expect(img.getAttribute("src")).toBe("/brand/bp-batam-emblem.svg");
    expect(img.style.width).toBe("22px");
    expect(img.classList.contains("x")).toBe(true);
  });
  it("provides the institutional accessible name and original logo", () => {
    render(<OmniRouteLockup />);
    expect(screen.getByRole("img", { name: "BP Batam AI Gateway" })).toBeTruthy();
    expect(screen.getByAltText("BP Batam — Badan Pengusahaan Batam").getAttribute("src")).toBe(
      "/brand/bp-batam-logo.png"
    );
  });
  it("keeps the full official lockup when saved branding uses BP Batam assets", () => {
    render(<OmniRouteLockup name="BP Batam AI Gateway" logoSrc="/brand/bp-batam-logo.png" />);
    expect(screen.getByAltText("BP Batam — Badan Pengusahaan Batam").getAttribute("width")).toBe(
      "190"
    );
  });
  it("retains explicit operator-owned white-label support", () => {
    render(<OmniRouteLockup name="Acme Router" logoSrc="data:image/png;base64,AAAA" />);
    expect(screen.getByRole("img", { name: "Acme Router" })).toBeTruthy();
  });
  it("does not restore legacy branding from an old stored name", () => {
    render(<OmniRouteLockup name="OmniRoute" />);
    expect(screen.getByRole("img", { name: "BP Batam AI Gateway" })).toBeTruthy();
    expect(screen.queryByText("OmniRoute")).toBeNull();
  });
});
