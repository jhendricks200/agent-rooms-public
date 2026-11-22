import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "next-auth/react";

// No web font is loaded here. The UI stack in globals.css (--font-ui) leads
// with the system font and names Manrope as the cross-platform fallback, per
// design/ds/SIGNAL-LAB-V2.md. Satoshi was removed: nothing referenced its
// CSS variable, and its Fontshare licence does not allow the font files to
// sit in a public repository.

export const metadata: Metadata = {
  title: "Agent Rooms",
  description: "Signal Lab - promote, fork, remix, adopt.",
};

// Applies the saved or OS theme before paint, so there is no flash of the
// wrong theme. Mirrors the inline script in design/direction-c2.html. The
// same pass restores the agent column's width and collapsed state, for the
// same reason: both are read from localStorage, so without this the column
// would paint at its default width and then jump.
const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem("signal-lab-theme");
    var theme = stored || (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
  try {
    var w = parseInt(localStorage.getItem("signal-lab-agent-width"), 10);
    if (w) {
      w = Math.min(560, Math.max(300, w));
      document.documentElement.style.setProperty("--agent-col-w", w + "px");
    }
    if (localStorage.getItem("signal-lab-agent-collapsed") === "1") {
      document.documentElement.setAttribute("data-agent-collapsed", "true");
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
