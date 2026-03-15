import { describe, expect, test } from "bun:test";

import { DomSnapshotBuilder } from "../lib/dom-snapshot";

describe("DomSnapshotBuilder", () => {
  test("builds a static DOM snapshot without executing page scripts", () => {
    const builder = new DomSnapshotBuilder();
    const snapshot = builder.build(
      `
        <html>
          <head>
            <title>Login</title>
            <meta name="description" content="Sign in to continue" />
            <script>window.__INITIAL_STATE__ = { ready: true };</script>
          </head>
          <body data-testid="login-page">
            <h1>Sign in</h1>
            <form action="/session" method="post">
              <input type="email" name="email" />
              <input type="password" name="password" />
              <button type="submit">Continue</button>
            </form>
            <iframe src="/challenge"></iframe>
          </body>
        </html>
      `,
      "https://example.com/login.html",
    );

    expect(snapshot.title).toBe("Login");
    expect(snapshot.description).toBe("Sign in to continue");
    expect(snapshot.headings).toEqual(["Sign in"]);
    expect(snapshot.forms).toEqual([
      {
        action: "https://example.com/session",
        method: "POST",
        inputNames: ["email", "password"],
        inputTypes: ["email", "password"],
        submitLabels: ["Continue"],
      },
    ]);
    expect(snapshot.iframes).toEqual(["https://example.com/challenge"]);
    expect(snapshot.inlineStateHints).toContain("global:__INITIAL_STATE__");
    expect(snapshot.dataAttributeKeys).toContain("data-testid");
  });

  test("does not crash on stylesheet-heavy pages", () => {
    const builder = new DomSnapshotBuilder();
    const snapshot = builder.build(
      `
        <html>
          <head>
            <title>Styled Login</title>
            <link rel="stylesheet" href="https://cdn.example.com/app.css" />
            <script>window.__BOOTSTRAP__ = { route: "login" };</script>
          </head>
          <body>
            <form action="/login" method="post">
              <input type="text" name="login" />
            </form>
          </body>
        </html>
      `,
      "https://example.com/login.html",
    );

    expect(snapshot.url).toBe("https://example.com/login.html");
    expect(snapshot.inlineStateHints).toContain("global:__BOOTSTRAP__");
    expect(snapshot.summary.length).toBeGreaterThan(0);
  });
});
