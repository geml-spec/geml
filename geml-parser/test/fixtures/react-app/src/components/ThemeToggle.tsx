import { useTheme } from "../context/ThemeContext";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    // `toggle` reaches this component through context — indirect dispatch,
    // the second pinned blind spot.
    <button onClick={() => toggle()}>
      {theme === "dark" ? "Light" : "Dark"} mode
    </button>
  );
}
