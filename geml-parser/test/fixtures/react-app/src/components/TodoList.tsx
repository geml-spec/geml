import type { Todo } from "../state/todosReducer";
import { TodoItem } from "./TodoItem";

export function TodoList({ todos, onToggle }: { todos: Todo[]; onToggle: (id: string) => void }) {
  if (todos.length === 0) return <p>Nothing to do.</p>;
  return (
    <ul>
      {todos.map((todo) => (
        <TodoItem key={todo.id} todo={todo} onToggle={onToggle} />
      ))}
    </ul>
  );
}
