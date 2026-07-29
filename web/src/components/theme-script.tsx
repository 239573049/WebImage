const themeScript = `
(() => {
  try {
    const stored = localStorage.getItem("chatgpt2api-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = stored === "light" || stored === "dark" ? stored : prefersDark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  } catch {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "light";
  }
  try {
    const sidebar = localStorage.getItem("chatgpt2api-sidebar");
    document.documentElement.dataset.sidebar = sidebar === "collapsed" ? "collapsed" : "expanded";
  } catch {
    document.documentElement.dataset.sidebar = "expanded";
  }
})();
`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: themeScript }} />;
}
