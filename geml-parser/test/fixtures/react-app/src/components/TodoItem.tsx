import { formatDate } from "../utils/format";
import type { Todo } from "../state/todosReducer";

interface TodoItemProps {
  todo: Todo;
  // Property-typed callback: calling it is indirect dispatch — the graph
  // cannot know it is App's `toggle`.
  onToggle: (id: string) => void;
}

export function TodoItem({ todo, onToggle }: TodoItemProps) {
  const handleClick = () => {
    onToggle(todo.id); // callback-prop call — the pinned blind spot
  };
  return (
    <li onClick={handleClick}>
      <input type="checkbox" checked={todo.done} readOnly />
      <span>{todo.title}</span>
      <time>{formatDate(todo.createdAt)}</time>
    </li>
  );
}
