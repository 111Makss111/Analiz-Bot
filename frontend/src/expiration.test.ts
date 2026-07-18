import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";

describe("first-stage application shell", () => {
  it("показує всі основні вкладки та експірації 1–3 хвилини", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("Аналіз");
    expect(html).toContain("Історія");
    expect(html).toContain("Статистика");
    expect(html).toContain("Контроль");
    expect(html).toContain("1</strong>");
    expect(html).toContain("2</strong>");
    expect(html).toContain("3</strong>");
  });
});
