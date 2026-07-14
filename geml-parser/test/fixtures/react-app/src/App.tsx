import { useMemo, useState } from "react";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { ThemeToggle } from "./components/ThemeToggle";
import { TodoList } from "./components/TodoList";
import { useTodos } from "./hooks/useTodos";

export function App() {
  const { todos, toggle, add } = useTodos();
  const [draft, setDraft] = useState("");
  const remaining = useMemo(() => todos.filter((t) => !t.done).length, [todos]);

  const handleSubmit = () => {
    if (draft.trim()) {
      add(draft.trim());
      setDraft("");
    }
  };

  return (
    <main>
      <Header count={remaining} />
      <ThemeToggle />
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={handleSubmit}>Add</button>
      <TodoList todos={todos} onToggle={toggle} />
      <Footer />
    </main>
  );
}
